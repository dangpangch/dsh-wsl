/**
 * Host-side `ctx.subprocess` implementation whose execution world is one WSL
 * distribution.
 *
 * Executable lookup, ordinary processes and terminal facts all happen beside the
 * WSL filesystem provider, so a path returned by {@link WslSubprocess.resolveExecutable}
 * is the same path the filesystem provider can open. That shared execution world is
 * a hard requirement of the seam, not a convenience.
 *
 * Scope of this provider
 * ----------------------
 * Implemented: executable lookup, `terminalEnvironment`, managed spawn with
 * collected stdout/stderr, stdin `ignore` or batch `{ data }`, termination by
 * process group, and managed-range observation.
 *
 * Refused loudly rather than silently degraded: raw `'pipe'` output streams and the
 * optional duplex `control` channel. Both need a second, independent stream channel.
 * M1's single framed pipe over `wsl.exe` cannot provide one while keeping
 * administrative replies unforgeable; the reference SSH provider gets that property
 * from per-stream SSH channels. dsh-wsl needs the in-distribution socket planned for
 * a later milestone, and rejecting the request is safer than pretending.
 *
 * @module @local/dsh-wsl/subprocess
 */
import { Writable } from 'node:stream'

/** Cap on host-side retained text per stream when the caller does not set one. */
const DEFAULT_COLLECT_BYTES = 1024 * 1024

/** Polling interval while waiting for new collected output or for exit. */
const POLL_INTERVAL_MS = 25

/** Bound on one `process.wait` round trip, so an abort stays responsive. */
const WAIT_SLICE_MS = 1000

/**
 * Environment names the harness must never forward implicitly.
 *
 * Credential-shaped names would leak secrets into a child and `DSH_*` names would
 * leak harness identity. Explicit spec entries still win, because they merge after
 * this scrub, so a deliberate opt-in is not broken by it.
 */
const SENSITIVE_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i

/**
 * Build the child environment base from an ambient environment.
 *
 * Mirrors the seam's documented scrub rather than inventing a different policy:
 * credential-shaped names and every `DSH_*` name are removed case-insensitively,
 * while PATH, HOME, locale and proxy entries survive so ordinary CLI tools behave
 * normally inside the distribution.
 *
 * @param {NodeJS.ProcessEnv} [ambient]
 * @returns {Record<string,string>}
 */
export function scrubbedEnv(ambient = process.env) {
  /** @type {Record<string,string>} */
  const out = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue
    if (/^dsh_/i.test(key)) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Host-side collector mirroring the seam's offset-based reader.
 *
 * The helper owns authoritative whole-stream offsets; this class accumulates the
 * decoded text the host has pulled and bounds what it retains. Exceeding the bound
 * drops the head, which is exactly the seam's `lossy` case. `spillPath` stays absent
 * because the host deliberately does not claim a complete stream it never retained.
 */
class HostCollector {
  #text = ''
  #remoteOffset = 0
  #finished = false

  /**
   * @param {number} maxBytes retained-text bound
   * @param {(fromByte: number) => Promise<{text: string, nextOffset: number, lossy: boolean}>} pull
   */
  constructor(maxBytes, pull) {
    this.maxBytes = maxBytes
    this.pull = pull
  }

  /**
   * Pull any new output.
   *
   * @param {boolean} [once] pull a single delta instead of draining
   */
  async refresh(once = false) {
    if (this.#finished) return
    for (;;) {
      const chunk = await this.pull(this.#remoteOffset)
      if (chunk.lossy) {
        // The helper's own tail slid; adopt its retained text wholesale.
        this.#text = chunk.text
        this.#remoteOffset = chunk.nextOffset
      } else if (chunk.text.length > 0) {
        this.#text += chunk.text
        this.#remoteOffset = chunk.nextOffset
      }
      this.#trim()
      if (once || chunk.text.length === 0 || chunk.lossy) break
    }
  }

  /** Mark that no further output can arrive. */
  finish() {
    this.#finished = true
  }

  /** @private */
  #trim() {
    let bytes = Buffer.byteLength(this.#text, 'utf8')
    if (bytes <= this.maxBytes) return
    const excess = bytes - this.maxBytes
    let cut = 0
    let removed = 0
    while (removed < excess && cut < this.#text.length) {
      removed += Buffer.byteLength(this.#text[cut], 'utf8')
      cut += 1
    }
    this.#text = this.#text.slice(cut)
    bytes = Buffer.byteLength(this.#text, 'utf8')
    void bytes
  }

  /**
   * Build the seam's reader over the retained text.
   *
   * Offsets are counts within what this reader has returned, because the helper's
   * whole-stream coordinates are not recoverable once the head was dropped and
   * inventing them would misreport the gap.
   *
   * @returns {{readFrom: (fromByte: number) => {text: string, nextOffset: number, lossy: boolean}}}
   */
  reader() {
    return {
      readFrom: (fromByte) => {
        const retained = Buffer.byteLength(this.#text, 'utf8')
        const retainedFrom = this.#remoteOffset - retained
        if (fromByte < retainedFrom) return { text: this.#text, nextOffset: this.#remoteOffset, lossy: true }
        const skip = Math.max(0, fromByte - retainedFrom)
        return {
          text: skip <= 0 ? this.#text : this.#text.slice(skip),
          nextOffset: this.#remoteOffset,
          lossy: false,
        }
      },
    }
  }
}

/**
 * One live process managed inside the distribution.
 *
 * Allocation may still be in flight when this object exists: the seam requires
 * `spawn` to return a live handle synchronously while remote ownership is
 * established. Every method therefore awaits {@link allocation} first, and a failed
 * allocation rejects `done` instead of leaving a handle that silently does nothing.
 */
export class WslProcessHandle {
  /** Helper-side process id, once allocation has completed. */
  id
  /** Top-level pid inside the distribution, once allocation has completed. */
  pid

  #stdoutCollector
  #stderrCollector
  #poller
  #outcome
  #terminated = false

  /**
   * @param {object} options
   * @param {Promise<{connection: import('./connection.js').WslConnection, id: string, pid: number|undefined}>} options.allocation
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} options.spec
   */
  constructor(options) {
    this.allocation = options.allocation
    this.spec = options.spec
    this.graceMs = options.spec.graceMs

    /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessCollectedOutputs} */
    this.collected = {}
    /** Raw streams are deliberately absent; see the module note. */
    this.stdout = undefined
    this.stderr = undefined
    this.control = undefined

    const stdoutMode = options.spec.stdio.stdout
    if (isCollect(stdoutMode)) {
      this.#stdoutCollector = new HostCollector(stdoutMode.maxBytes ?? DEFAULT_COLLECT_BYTES, (from) =>
        this.#read('stdout', from),
      )
      this.collected.stdout = this.#stdoutCollector.reader()
    }
    const stderrMode = options.spec.stdio.stderr
    if (isCollect(stderrMode)) {
      this.#stderrCollector = new HostCollector(stderrMode.maxBytes ?? DEFAULT_COLLECT_BYTES, (from) =>
        this.#read('stderr', from),
      )
      this.collected.stderr = this.#stderrCollector.reader()
    }

    const stdinMode = options.spec.stdio.stdin
    if (stdinMode === 'pipe' || isData(stdinMode)) {
      // The ongoing `pipe` shape exposes a live writer; the batch `data` shape uses
      // the same writer internally but exposes none, matching the seam's contract.
      this.stdin = stdinMode === 'pipe' ? new Writable({
        write: (chunk, _encoding, callback) => {
          this.#request('process.write', { data: chunk.toString('utf8') }).then(
            () => callback(),
            (error) => callback(error),
          )
        },
        final: (callback) => {
          this.#request('process.endStdin', {}).then(
            () => callback(),
            (error) => callback(error),
          )
        },
      }) : undefined
    } else {
      this.stdin = undefined
    }

    this.done = new Promise((resolve, reject) => {
      this.#resolveDone = resolve
      this.#rejectDone = reject
      this.allocation.then(
        ({ id, pid }) => {
          this.id = id
          this.pid = pid
          // The batch shape delivers its bytes and closes stdin, once the remote
          // process exists. The handle owns this rather than the spawn request, so a
          // write can never race remote allocation.
          if (isData(options.spec.stdio.stdin)) {
            this.#request('process.write', { data: options.spec.stdio.stdin.data })
              .then(() => this.#request('process.endStdin', {}))
              .catch((error) => this.#rejectDone(error))
          }
        },
        (error) => {
          clearInterval(this.#poller)
          reject(error)
        },
      )
    })
    // An unawaited rejection must not crash the process.
    this.done.catch(() => {})

    options.spec.signal?.addEventListener('abort', () => this.terminate(), { once: true })
    this.#poller = setInterval(() => void this.#tick(), POLL_INTERVAL_MS)
    this.#poller.unref?.()
  }

  #resolveDone
  #rejectDone

  /** @private */
  async #request(method, params, options) {
    const { connection, id } = await this.allocation
    return connection.request(method, { id, ...params }, options)
  }

  /** @private */
  async #read(stream, fromByte) {
    const result = await this.#request('process.read', { stream, fromByte })
    return result
  }

  /** @private */
  async #tick() {
    if (this.#outcome) return
    try {
      await this.#stdoutCollector?.refresh(true)
      await this.#stderrCollector?.refresh(true)
      const { connection, id } = await this.allocation
      const poll = await connection.request('process.poll', { id })
      if (poll.outcome) this.#settle(poll.outcome)
    } catch (error) {
      clearInterval(this.#poller)
      this.#rejectDone(error)
    }
  }

  /**
   * Record exit facts, take one final output pull, then stop polling.
   *
   * @private
   * @param {{exitCode: number|null, signal: string|null}} outcome
   */
  #settle(outcome) {
    if (this.#outcome) return
    this.#outcome = outcome
    clearInterval(this.#poller)
    void Promise.allSettled([
      this.#stdoutCollector?.refresh(true),
      this.#stderrCollector?.refresh(true),
    ]).then(() => {
      this.#stdoutCollector?.finish()
      this.#stderrCollector?.finish()
      this.#resolveDone(outcome)
    })
  }

  /**
   * Begin the provider's termination procedure on the managed range.
   *
   * Idempotent, and a no-op once the range has emptied.
   */
  terminate() {
    if (this.#terminated || this.#outcome) return
    this.#terminated = true
    void this.#request('process.terminate', { graceMs: this.graceMs }).catch(() => {})
  }

  /**
   * Wait until the managed range is empty.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<boolean>} true when empty, false when the signal aborted first
   */
  async waitForExit(signal) {
    for (;;) {
      if (this.#outcome) return true
      if (signal?.aborted) return false
      try {
        const { connection, id } = await this.allocation
        const result = await connection.request(
          'process.wait',
          { id, timeoutMs: WAIT_SLICE_MS },
          { signal },
        )
        if (result.outcome) {
          this.#settle(result.outcome)
          return true
        }
      } catch (error) {
        // An abort ends a bounded wait; it is not a provider failure.
        if (signal?.aborted) return false
        throw error
      }
      if (signal?.aborted) return false
    }
  }
}

/**
 * @param {unknown} mode
 * @returns {mode is {maxBytes?: number}}
 */
function isCollect(mode) {
  return typeof mode === 'object' && mode !== null && !('data' in mode)
}

/**
 * @param {unknown} mode
 * @returns {mode is {data: string}}
 */
function isData(mode) {
  return typeof mode === 'object' && mode !== null && typeof mode.data === 'string'
}

/**
 * `ctx.subprocess` implementation backed by one WSL distribution.
 *
 * The connection is established lazily so the provider can be constructed during
 * plugin activation without blocking it on provisioning.
 */
export class WslSubprocess {
  /**
   * @param {object} options
   * @param {() => Promise<import('./connection.js').WslConnection>} options.connect
   *   establishes (and caches) this provider's connection
   */
  constructor(options) {
    this.connect = options.connect
    /** @type {Promise<import('./connection.js').WslConnection>|undefined} */
    this.#pending = undefined
  }

  #pending

  /** Establish the connection once, reusing it afterwards. */
  connection() {
    this.#pending ??= this.connect()
    return this.#pending.then((connection) => {
      if (!connection.closed) return connection
      // The cached connection died; drop it so the next call reconnects through the runtime.
      this.#pending = undefined
      return this.connection()
    })
  }

  /** Release this provider's connection and every process the helper still manages. */
  async dispose() {
    if (!this.#pending) return
    const connection = await this.#pending
    await connection.dispose()
  }

  /**
   * Resolve one executable inside the distribution.
   *
   * @param {string} command absolute path or bare PATH name
   * @param {Readonly<Record<string,string>>} [env] explicit lookup environment
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>} canonical absolute path inside the distribution
   */
  async resolveExecutable(command, env, signal) {
    const connection = await this.connection()
    const result = await connection.request(
      'exec.resolve',
      { command, env: env ? { ...env } : undefined },
      { signal },
    )
    return result.path
  }

  /**
   * Shell-selection facts for this execution world.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{platform: 'posix', defaultShell?: string}>}
   */
  async terminalEnvironment(signal) {
    const connection = await this.connection()
    const result = await connection.request('terminal.env', {}, { signal })
    return { platform: 'posix', defaultShell: result.defaultShell ?? undefined }
  }

  /**
   * Start one managed child process inside the distribution.
   *
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec
   * @returns {WslProcessHandle} a live handle; remote allocation proceeds behind it
   */
  spawn(spec) {
    validateSpawnSpec(spec)

    const allocation = (async () => {
      const connection = await this.connection()
      const stdio = {
        stdin: spec.stdio.stdin === 'pipe' ? 'pipe' : isData(spec.stdio.stdin) ? 'data' : 'ignore',
        stdout: isCollect(spec.stdio.stdout) ? { maxBytes: spec.stdio.stdout.maxBytes } : 'ignore',
        stderr: isCollect(spec.stdio.stderr) ? { maxBytes: spec.stdio.stderr.maxBytes } : 'ignore',
      }
      // The host PATH is Windows-flavoured; forwarding it can only break
      // bare-name lookup inside the distribution. The helper defaults the
      // child's PATH to its own, and an explicit spec PATH still wins.
      const base = scrubbedEnv()
      delete base.PATH
      const started = await connection.request('process.spawn', {
        argv: [...spec.argv],
        cwd: spec.cwd,
        env: { ...base, ...normalizeEnv(spec.env) },
        stdin: stdio.stdin,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
        graceMs: spec.graceMs,
      })
      return { connection, id: started.id, pid: started.pid }
    })()

    return new WslProcessHandle({ allocation, spec })
  }
}

/**
 * Validate a spawn spec before any remote effect.
 *
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec
 */
function validateSpawnSpec(spec) {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
    throw new TypeError('subprocess: argv must be a non-empty array')
  }
  if (typeof spec.cwd !== 'string' || !spec.cwd.startsWith('/')) {
    throw new TypeError('subprocess: cwd must be an absolute path in the distribution')
  }
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
    throw new TypeError('subprocess: graceMs must be a positive finite number')
  }
  if (spec.signal?.aborted) {
    throw new TypeError('subprocess: the spec was already aborted')
  }
  for (const [name, mode] of [
    ['stdout', spec.stdio.stdout],
    ['stderr', spec.stdio.stderr],
  ]) {
    if (mode === 'pipe') {
      throw new TypeError(
        `subprocess: raw ${name} streams are not supported over the WSL control channel yet`,
      )
    }
  }
  if (spec.stdio.control === 'pipe') {
    throw new TypeError('subprocess: the optional duplex control channel is not supported yet')
  }
}

/**
 * Merge explicit environment entries onto a base.
 *
 * `undefined` values are tombstones in the seam's vocabulary: they are dropped here
 * and, because the scrubbed base only contains surviving entries, dropping them still
 * achieves the documented "remove this ambient entry" effect.
 *
 * @param {NodeJS.ProcessEnv|undefined} explicit
 * @returns {Record<string,string>}
 */
function normalizeEnv(explicit) {
  /** @type {Record<string,string>} */
  const out = {}
  if (!explicit) return out
  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}
