/**
 * Host-side connection to one WSL distribution.
 *
 * Owns the `wsl.exe` transport, the framed control channel, the helper's lease,
 * and the provisioned Node runtime the helper runs on. Loss of transport
 * invalidates every in-flight operation: like the reference SSH connection,
 * operations are never reconnected or replayed, because a disconnected client
 * cannot confirm what already committed inside the distribution.
 *
 * Transport note
 * --------------
 * `wsl.exe` gives one framed pipe over stdio, not the per-stream socket
 * forwarding the reference SSH connection uses. Large payloads and program
 * streams therefore share the control channel until a later milestone adds a
 * separate in-distro socket. Administrative ordering is unaffected because the
 * helper answers requests in arrival order.
 *
 * @module @local/dsh-wsl/connection
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  FrameDecoder,
  FrameType,
  HelperError,
  HelperErrorCode,
  PROTOCOL_VERSION,
  assertHello,
  encodeFrame,
} from './protocol.js'
import { NODE_ARCHIVE, NODE_SHA256, NODE_VERSION, nodeArchiveUrl } from './runtime.js'

/** Default administrative deadline, matching the reference SSH connection. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Default host heartbeat cadence; must stay well inside the helper's lease. */
const DEFAULT_HEARTBEAT_MS = 10_000
/** Default helper lease; the helper tears down managed ranges after this silence. */
const DEFAULT_LEASE_MS = 60_000
/** Bounded window for the helper to finish remote cleanup during disposal. */
const DISPOSE_GRACE_MS = 2_000

/* -------------------------------------------------------------------------- */
/* wsl.exe process primitives                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Decode `wsl.exe` output that may be UTF-8 or UTF-16LE.
 *
 * `WSL_UTF8=1` is set for every invocation, but the flag has no effect on some
 * older builds, so both encodings are tolerated rather than assumed.
 *
 * @param {string|Buffer} output raw bytes or an already-decoded string
 * @returns {string} decoded text
 */
function decodeWslText(output) {
  if (typeof output === 'string') return output.replace(/\0/g, '')
  if (output.includes(0)) return output.toString('utf16le').replace(/\0/g, '')
  return output.toString('utf8')
}

/**
 * Run a one-shot `wsl.exe` command and collect its output.
 *
 * @param {string[]} argv arguments after the executable name
 * @param {{input?: Buffer|string, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number|null, stdout: Buffer, stderr: Buffer}>}
 */
export function runWsl(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', argv, {
      env: { ...process.env, WSL_UTF8: '1' },
      windowsHide: true,
    })
    const out = []
    const err = []
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      child.kill()
      finish(reject, new HelperError(HelperErrorCode.ABORTED, 'wsl.exe invocation aborted'))
    }
    const timer = options.timeoutMs ? setTimeout(onAbort, options.timeoutMs) : undefined
    timer?.unref?.()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) =>
      finish(resolve, { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    )
    child.stdin.end(options.input ?? undefined)
  })
}

/**
 * Run one bash command inside a distribution.
 *
 * @param {{distro?: string, user?: string, command: string, input?: Buffer|string, signal?: AbortSignal}} options
 * @returns {Promise<{code: number|null, stdoutText: string, stderrText: string, stdout: Buffer, stderr: Buffer}>}
 */
async function runInDistro(options) {
  const argv = []
  if (options.distro) argv.push('-d', options.distro)
  if (options.user) argv.push('-u', options.user)
  argv.push('--', 'bash', '-lc', options.command)

  const result = await runWsl(argv, { input: options.input, signal: options.signal })
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutText: result.stdout.toString('utf8'),
    stderrText: result.stderr.toString('utf8'),
  }
}

/**
 * Single-quote a value for a POSIX shell.
 *
 * @param {string} value
 * @returns {string} safely quoted for bash
 */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/* -------------------------------------------------------------------------- */
/* distribution discovery                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the WSL distribution list.
 *
 * `wsl.exe -l -v` is the only reliable enumeration.
 *
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Array<{name: string, state: string, version: string, default: boolean}>>}
 */
export async function listDistributions(options = {}) {
  const { stdout } = await runWsl(['-l', '-v'], { signal: options.signal })
  return parseDistributionList(stdout)
}

/**
 * Parse `wsl.exe -l -v` output.
 *
 * Exported for testing: the format is column-aligned text whose first column may
 * carry a `*` marking the default distribution.
 *
 * @param {string|Buffer} output raw stdout
 * @returns {Array<{name: string, state: string, version: string, default: boolean}>}
 */
export function parseDistributionList(output) {
  const text = decodeWslText(output)
  const rows = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    if (/^\s*NAME\s+STATE\s+VERSION\s*$/i.test(line)) continue
    const isDefault = /^\s*\*/.test(line)
    const fields = line.replace(/^\s*\*?\s*/, '').trim().split(/\s+/)
    if (fields.length < 3) continue
    const [name, state, version] = fields
    rows.push({ name, state, version, default: isDefault })
  }
  return rows
}

/* -------------------------------------------------------------------------- */
/* connection                                                                 */
/* -------------------------------------------------------------------------- */

/** One live connection to a distribution. */
export class WslConnection {
  #child
  #decoder = new FrameDecoder()
  /** @type {Map<number, {resolve: Function, reject: Function, timer: any, signal?: AbortSignal, onAbort?: () => void}>} */
  #pending = new Map()
  #nextId = 1
  #hello
  #heartbeat
  #closed = false
  #failure
  /** @type {Set<(error: Error) => void>} */
  #closeListeners = new Set()
  #resolveHello
  #rejectHello
  #stderr = ''

  /**
   * @param {object} config
   * @param {string} [config.distro] distribution name; omitting it uses the system default
   * @param {string} [config.user] Linux user to run as; omitting it uses the distribution default
   * @param {string} config.helperPath absolute Linux path of the deployed helper
   * @param {string} config.nodePath absolute Linux path of the deployed Node executable
   * @param {number} [config.requestTimeoutMs]
   * @param {number} [config.heartbeatMs]
   * @param {number} [config.leaseMs]
   * @param {(message: object) => void} [config.onFrame] observe every inbound frame
   */
  constructor(config) {
    this.config = {
      distro: config.distro,
      user: config.user,
      helperPath: config.helperPath,
      nodePath: config.nodePath,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      heartbeatMs: config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      leaseMs: config.leaseMs ?? DEFAULT_LEASE_MS,
      onFrame: config.onFrame,
    }
    this.ready = new Promise((resolve, reject) => {
      this.#resolveHello = resolve
      this.#rejectHello = reject
    })
    // An unawaited rejection must not crash the process.
    this.ready.catch(() => {})
  }

  /** Verified helper handshake; rejects when the launch or protocol check fails. */
  ready

  /**
   * The verified helper handshake, or undefined before it arrives.
   *
   * @returns {{protocolVersion: number, pid: number, platform: string, arch: string, nodeVersion: string, helper: string}|undefined}
   */
  get hello() {
    return this.#hello
  }

  /**
   * Launch the helper and return as soon as its handshake verifies.
   *
   * @returns {Promise<this>}
   */
  async start() {
    if (this.#child) return this
    if (!this.config.nodePath || !this.config.helperPath) {
      const error = new HelperError(
        HelperErrorCode.INVALID_PARAMS,
        'nodePath and helperPath must be resolved (see ensureRuntime) before starting',
      )
      this.#fail(error)
      return this
    }

    const args = []
    if (this.config.distro) args.push('-d', this.config.distro)
    if (this.config.user) args.push('-u', this.config.user)
    // No --cd: it would translate a Windows path and the helper must start in Linux.
    args.push(
      '--',
      this.config.nodePath,
      this.config.helperPath,
      '--lease-ms',
      String(this.config.leaseMs),
    )

    this.#child = spawn('wsl.exe', args, {
      env: { ...process.env, WSL_UTF8: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.#child.stderr.on('data', (chunk) => (this.#stderr += chunk.toString('utf8')))
    this.#child.on('error', (error) => this.#fail(error))
    this.#child.on('close', (code, signal) =>
      this.#fail(
        new HelperError(
          HelperErrorCode.IO_ERROR,
          `helper exited (code=${code}, signal=${signal ?? 'none'})` +
            (this.#stderr.trim() ? `; stderr: ${this.#stderr.trim()}` : ''),
        ),
      ),
    )

    // A helper that never speaks must not hang the caller forever.
    const guard = setTimeout(() => {
      this.#fail(
        new HelperError(
          HelperErrorCode.IO_ERROR,
          `helper did not announce itself within ${this.config.requestTimeoutMs} ms` +
            (this.#stderr.trim() ? `; stderr: ${this.#stderr.trim()}` : ''),
        ),
      )
    }, this.config.requestTimeoutMs)
    guard.unref?.()
    this.ready.then(() => clearTimeout(guard)).catch(() => clearTimeout(guard))

    await this.ready
    return this
  }

  /** @private */
  #onData(chunk) {
    let messages
    try {
      messages = this.#decoder.push(chunk)
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)))
      return
    }

    for (const message of messages) {
      this.config.onFrame?.(message)

      if (message.type === FrameType.HELLO && !this.#hello) {
        try {
          this.#hello = assertHello(message)
          this.#resolveHello(this.#hello)
          this.#startHeartbeat()
        } catch (error) {
          this.#fail(error instanceof Error ? error : new Error(String(error)))
        }
        continue
      }
      if (message.type === FrameType.HEARTBEAT) continue
      if (message.type === FrameType.SHUTDOWN) {
        this.#fail(
          new HelperError(
            HelperErrorCode.IO_ERROR,
            `helper shut down: ${message.reason ?? 'unknown'}`,
          ),
          { clean: true },
        )
        continue
      }

      const entry = this.#pending.get(message.id)
      if (!entry) continue
      this.#pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener('abort', entry.onAbort)
      if (message.type === FrameType.RESPONSE) {
        entry.resolve(message.result)
      } else {
        const error = new HelperError(
          message.code ?? HelperErrorCode.INTERNAL,
          message.message ?? 'helper error',
          message.details,
        )
        // The helper forwards a domain error code (for example `FS_STALE_VERSION`)
        // that its transport vocabulary cannot name; expose it so providers can
        // rethrow the caller-visible code.
        if (typeof message.appCode === 'string') error.appCode = message.appCode
        entry.reject(error)
      }
    }
  }

  /** @private */
  #startHeartbeat() {
    if (this.#heartbeat) return
    this.#heartbeat = setInterval(() => {
      this.#send({ type: FrameType.HEARTBEAT }).catch(() => {})
    }, this.config.heartbeatMs)
    this.#heartbeat.unref?.()
  }

  /** @private */
  #send(message) {
    if (this.#closed) {
      return Promise.reject(
        this.#failure ?? new HelperError(HelperErrorCode.IO_ERROR, 'connection is closed'),
      )
    }
    let frame
    try {
      frame = encodeFrame(message)
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      const stdin = this.#child?.stdin
      if (!stdin?.writable) {
        reject(new HelperError(HelperErrorCode.IO_ERROR, 'helper stdin is not writable'))
        return
      }
      stdin.write(frame, (error) => (error ? reject(error) : resolve()))
    })
  }

  /**
   * Send one administrative request.
   *
   * @template T
   * @param {string} method helper method name
   * @param {unknown} [params] JSON request fields
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<T>} the helper's result
   */
  async request(method, params, options = {}) {
    await this.ready
    const id = this.#nextId++
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs

    return await new Promise((resolve, reject) => {
      /** @type {any} */
      const entry = { resolve, reject, timer: undefined, signal: options.signal }
      entry.timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new HelperError(HelperErrorCode.IO_ERROR, `request "${method}" exceeded ${timeoutMs} ms`),
        )
      }, timeoutMs)
      entry.timer.unref?.()

      if (options.signal) {
        entry.onAbort = () => {
          this.#pending.delete(id)
          clearTimeout(entry.timer)
          reject(new HelperError(HelperErrorCode.ABORTED, `request "${method}" aborted`))
        }
        options.signal.addEventListener('abort', entry.onAbort, { once: true })
      }

      this.#pending.set(id, entry)
      this.#send({ type: FrameType.REQUEST, id, method, params }).catch((error) => {
        this.#pending.delete(id)
        clearTimeout(entry.timer)
        reject(error)
      })
    })
  }

  /** @private */
  #fail(error, options = {}) {
    if (this.#closed) return
    this.#closed = true
    this.#failure = error
    clearInterval(this.#heartbeat)
    this.#heartbeat = undefined

    this.#rejectHello(error)
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id)
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener('abort', entry.onAbort)
      entry.reject(error)
    }
    for (const listener of this.#closeListeners) listener(error)
    this.#closeListeners.clear()

    // A clean helper shutdown exited on its own; anything else must not linger.
    if (!options.clean) {
      try {
        this.#child?.kill()
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Observe connection loss.
   *
   * @param {(error: Error) => void} listener called once, on the first failure
   * @returns {() => void} unsubscribe
   */
  onClose(listener) {
    if (this.#failure) {
      listener(this.#failure)
      return () => {}
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  /** True once the transport or helper has failed. */
  get closed() {
    return this.#closed
  }

  /** Accumulated helper stderr, for diagnosing a failed launch. */
  get stderrText() {
    return this.#stderr
  }

  /**
   * Ask the helper to tear down its managed ranges, then release the transport.
   *
   * Remote teardown is bounded and best-effort: the caller is never blocked on an
   * unresponsive distribution, and cleanup also happens by helper lease expiry.
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.#closed) return
    try {
      await this.#send({ type: FrameType.SHUTDOWN })
    } catch {
      /* the helper may already be gone */
    }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), DISPOSE_GRACE_MS)
      timer.unref?.()
      if (!this.#child) {
        clearTimeout(timer)
        resolve(true)
        return
      }
      this.#child.once('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      try {
        this.#child?.kill()
      } catch {
        /* already gone */
      }
    }
    this.#fail(new HelperError(HelperErrorCode.IO_ERROR, 'connection disposed'), { clean: true })
  }
}

/* -------------------------------------------------------------------------- */
/* runtime provisioning                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Compute a buffer's SHA-256.
 *
 * @param {Buffer} data bytes to hash
 * @returns {string} lowercase hex digest
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Download the pinned Node archive and verify it against the published checksum.
 *
 * A mismatch throws rather than installing an unverified runtime.
 *
 * @param {object} options
 * @param {string} options.cacheDir Windows-side cache directory
 * @param {string} [options.baseUrl] override the download origin
 * @param {boolean} [options.force] ignore an already-cached archive
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{archivePath: string, sha256: string, reused: boolean}>}
 */
export async function fetchNodeArchive(options) {
  const { cacheDir, baseUrl, force = false, signal } = options
  if (!cacheDir) throw new HelperError(HelperErrorCode.INVALID_PARAMS, 'cacheDir is required')

  const archivePath = path.join(cacheDir, NODE_ARCHIVE)
  if (!force) {
    const cached = await readIfPresent(archivePath)
    if (cached && sha256(cached) === NODE_SHA256) {
      return { archivePath, sha256: NODE_SHA256, reused: true }
    }
  }

  const response = await fetch(nodeArchiveUrl(baseUrl), { signal })
  if (!response.ok) {
    throw new HelperError(
      HelperErrorCode.IO_ERROR,
      `downloading ${NODE_ARCHIVE} failed with HTTP ${response.status}`,
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = sha256(bytes)
  if (digest !== NODE_SHA256) {
    throw new HelperError(
      HelperErrorCode.IO_ERROR,
      `checksum mismatch for ${NODE_ARCHIVE}: expected ${NODE_SHA256}, received ${digest}`,
      { expected: NODE_SHA256, received: digest },
    )
  }

  await mkdir(cacheDir, { recursive: true })
  // Publish atomically so a truncated download can never look like a valid cache hit.
  const staging = `${archivePath}.partial`
  await writeFile(staging, bytes)
  await rename(staging, archivePath)
  return { archivePath, sha256: digest, reused: false }
}

/**
 * Read a file, returning undefined when it is absent.
 *
 * @param {string} filePath
 * @returns {Promise<Buffer|undefined>}
 */
async function readIfPresent(filePath) {
  try {
    return await readFile(filePath)
  } catch {
    return undefined
  }
}

/**
 * Deploy a Node runtime into the distribution and prove it executes.
 *
 * Strategies, in order of preference:
 *  1. `push`     — download on this machine and unpack inside the distribution. The
 *                  default: the distribution then needs no egress at all, which is
 *                  what makes a locked-down host work.
 *  2. `distro`   — download inside the distribution, for a host with no egress.
 *  3. `existing` — require a Node already present at the expected path.
 *
 * @param {object} options
 * @param {string} options.distro
 * @param {string} [options.user]
 * @param {string} options.homeDir Linux home of the target user
 * @param {'push'|'distro'|'existing'} [options.strategy]
 * @param {string} options.cacheDir Windows-side archive cache
 * @param {AbortSignal} [options.signal]
 * @param {(line: string) => void} [options.onLog] progress narration for the UI
 * @returns {Promise<{nodePath: string, runtimeDir: string, strategy: string, version: string}>}
 */
export async function ensureRuntime(options) {
  const { distro, user, homeDir, strategy = 'push', cacheDir, signal, onLog = () => {} } = options
  if (!homeDir) throw new HelperError(HelperErrorCode.INVALID_PARAMS, 'homeDir is required')
  if (!cacheDir) throw new HelperError(HelperErrorCode.INVALID_PARAMS, 'cacheDir is required')

  const runtimeDir = `${homeDir}/.local/share/dsh-wsl/${distro}`
  // The archive is node-v<X>-<plat>/…; extracting with --strip-components=1 lands
  // `bin/node` directly under the runtime directory.
  const nodePath = `${runtimeDir}/bin/node`

  if (strategy !== 'existing') {
    // Reuse an already-deployed runtime. Re-downloading and re-extracting on every
    // connect would be the reference provider's "reuse prepared resources" rule
    // inverted, and it would stall startup for no gain.
    const existing = await runInDistro({
      distro,
      user,
      command: `test -x ${quote(nodePath)} && ${quote(nodePath)} --version || echo DSH_WSL_MISSING`,
      signal,
    })
    const reported = existing.stdoutText.trim()
    if (existing.code === 0 && !reported.endsWith('DSH_WSL_MISSING') && reported.startsWith('v')) {
      onLog(`reusing the runtime already installed in ${distro} (${reported})`)
      return { nodePath, runtimeDir, strategy, version: reported }
    }
  }

  if (strategy === 'existing') {
    const probe = await runInDistro({
      distro,
      user,
      command: `test -x ${quote(nodePath)} && ${quote(nodePath)} --version || echo DSH_WSL_MISSING`,
      signal,
    })
    const version = probe.stdoutText.trim()
    if (probe.code !== 0 || version.endsWith('DSH_WSL_MISSING')) {
      throw new HelperError(
        HelperErrorCode.NOT_FOUND,
        `no Node at ${nodePath} and strategy is "existing"`,
      )
    }
    return { nodePath, runtimeDir, strategy, version }
  }

  await mkdir(cacheDir, { recursive: true })

  if (strategy === 'push') {
    onLog(`downloading ${NODE_ARCHIVE} on this machine`)
    const { archivePath, reused } = await fetchNodeArchive({ cacheDir, signal })
    onLog(reused ? 'reusing verified cached archive' : 'archive verified against published checksum')

    onLog(`deploying runtime into ${distro}:${runtimeDir}`)
    const bytes = await readFile(archivePath)
    const unpack = await runInDistro({
      distro,
      user,
      command: `mkdir -p ${quote(runtimeDir)} && tar -xJ -C ${quote(runtimeDir)} --strip-components=1 -f -`,
      input: bytes,
      signal,
    })
    if (unpack.code !== 0) {
      throw new HelperError(
        HelperErrorCode.IO_ERROR,
        `unpacking the runtime failed: ${unpack.stderrText.trim() || 'unknown error'}`,
      )
    }
  } else {
    onLog(`downloading ${NODE_ARCHIVE} inside ${distro}`)
    const command = [
      `set -e`,
      `mkdir -p ${quote(runtimeDir)}`,
      `tmp=$(mktemp -d)`,
      `curl -fsSL ${quote(nodeArchiveUrl())} -o "$tmp/${NODE_ARCHIVE}"`,
      `printf '%s  %s\\n' ${quote(NODE_SHA256)} "$tmp/${NODE_ARCHIVE}" | sha256sum -c -`,
      `tar -xJ -C ${quote(runtimeDir)} --strip-components=1 -f "$tmp/${NODE_ARCHIVE}"`,
      `rm -rf "$tmp"`,
      `echo DSH_WSL_INSTALLED`,
    ].join('\n')
    const result = await runInDistro({ distro, user, command, signal })
    if (result.code !== 0 || !result.stdoutText.includes('DSH_WSL_INSTALLED')) {
      throw new HelperError(
        HelperErrorCode.IO_ERROR,
        `in-distribution install failed: ${result.stderrText.trim() || 'unknown error'}`,
      )
    }
  }

  // Prove the deployed runtime actually executes before anything depends on it.
  const verify = await runInDistro({ distro, user, command: `${quote(nodePath)} --version`, signal })
  const reported = verify.stdoutText.trim()
  if (verify.code !== 0 || !reported.startsWith('v')) {
    throw new HelperError(
      HelperErrorCode.IO_ERROR,
      `deployed Node at ${nodePath} did not run: ${verify.stderrText.trim() || 'no output'}`,
    )
  }
  onLog(`runtime ready: ${reported}`)
  return { nodePath, runtimeDir, strategy, version: reported }
}

/**
 * Copy the helper and its protocol module into the distribution.
 *
 * The pair is deployed as loose files, not installed as a package, so the helper's
 * relative import of `./protocol.js` resolves without any registry access. Both
 * files come from the helper directory, where `protocol.js` is a synced copy of the
 * authoritative module in `lib/` (see `tools/sync-helper.mjs` and the drift test).
 *
 * @param {object} options
 * @param {string} options.distro
 * @param {string} [options.user]
 * @param {string} options.homeDir Linux home of the target user
 * @param {string} options.sourceDir local directory holding the helper pair
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{helperPath: string, protocolPath: string, helperHash: string, deployDir: string}>}
 */
export async function deployHelper(options) {
  const { distro, user, homeDir, sourceDir, signal } = options
  const deployDir = `${homeDir}/.local/share/dsh-wsl/${distro}/helper`
  await runInDistro({ distro, user, command: `mkdir -p ${quote(deployDir)}`, signal })

  const files = ['protocol.js', 'fsio.mjs', 'wsl-helper.mjs']
  /** @type {Record<string, string>} */
  const digests = {}
  for (const name of files) {
    const bytes = await readFile(path.join(sourceDir, name))
    digests[name] = sha256(bytes)
    // Stream over stdin and write with a redirect: no shared mount, no base64 blowup.
    const written = await runInDistro({
      distro,
      user,
      command: `cat > ${quote(`${deployDir}/${name}`)}`,
      input: bytes,
      signal,
    })
    if (written.code !== 0) {
      throw new HelperError(
        HelperErrorCode.IO_ERROR,
        `deploying ${name} failed: ${written.stderrText.trim() || 'unknown error'}`,
      )
    }
    // Read it back and compare: a host that cannot verify its own deployment cannot
    // trust the digest it reports to callers.
    const readBack = await runInDistro({
      distro,
      user,
      command: `sha256sum ${quote(`${deployDir}/${name}`)}`,
      signal,
    })
    const remoteDigest = readBack.stdoutText.trim().split(/\s+/)[0]
    if (remoteDigest !== digests[name]) {
      throw new HelperError(
        HelperErrorCode.IO_ERROR,
        `deployed ${name} does not match what was sent (local ${digests[name]}, remote ${remoteDigest})`,
      )
    }
  }

  return {
    helperPath: `${deployDir}/wsl-helper.mjs`,
    protocolPath: `${deployDir}/protocol.js`,
    helperHash: digests['wsl-helper.mjs'],
    deployDir,
  }
}

/** Protocol revision this build speaks; surfaced for diagnostics. */
export const WIRE_VERSION = PROTOCOL_VERSION

/** Pinned runtime coordinates, surfaced so the settings page can report them. */
export const RUNTIME = Object.freeze({
  version: NODE_VERSION,
  archive: NODE_ARCHIVE,
  sha256: NODE_SHA256,
})
