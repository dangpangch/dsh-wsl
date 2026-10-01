/**
 * Host-side `ctx.fs` implementation whose execution world is one WSL distribution.
 *
 * The provider owns target identity (a canonical Linux path), path translation
 * between the two path spaces, and the error taxonomy. All file mutation semantics —
 * realpath identity, version tokens, atomic publication, literal edits with
 * line-ending preservation — are implemented beside the data in the helper's
 * `fsio` module and only *driven* from here, so the host never holds a second,
 * subtly different implementation of a mutation rule.
 *
 * Watching is deliberately unsupported
 * ------------------------------------
 * `watch()` on the base class already rejects with `FS_IO_ERROR`, and the reference
 * SSH provider keeps exactly that behavior rather than polling a remote path. A
 * watcher that works by polling would burn a round trip per interval per target
 * across the same single control channel that carries every other operation, so
 * this provider inherits the rejection and documents it instead of pretending.
 *
 * @module @local/dsh-wsl/fs
 */
import {
  expandHome,
  isWindowsBackedPath,
  joinLinux,
  linuxToWindows,
  windowsToLinux,
} from './paths.js'

/** Text-read cap the helper enforces for a whole-file read, mirroring the reference. */
const WHOLE_TEXT_READ_LIMIT = 8 * 1024 * 1024

/** Window size for streamed text, chosen to stay well inside the frame ceiling. */
const STREAM_CHUNK_BYTES = 512 * 1024

/**
 * Filesystem error carrying a harness `FsErrorCode`.
 *
 * The service module exports its own `FsError`; this class mirrors its shape so the
 * provider stays usable without importing a peer at construction time, and the
 * Cordis service wrapper rethrows as the seam's own class.
 */
export class WslFsError extends Error {
  /**
   * @param {string} message
   * @param {string} code harness `FsErrorCode`
   * @param {unknown} [cause]
   */
  constructor(message, code, cause) {
    super(message)
    this.name = 'FsError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Rebuild a helper-side failure as a provider-visible `WslFsError`.
 *
 * The transport carries the domain code out of band as `appCode`, because its own
 * code vocabulary is narrower than the filesystem taxonomy. Reading it here keeps the
 * real `FS_*` code visible to callers instead of collapsing everything to
 * `FS_IO_ERROR`.
 *
 * @param {unknown} error
 * @returns {WslFsError}
 */
function asFsError(error) {
  if (error instanceof WslFsError) return error
  const held = /** @type {{code?: unknown, appCode?: unknown}} */ (error)
  for (const candidate of [held?.appCode, held?.code]) {
    if (typeof candidate === 'string' && candidate.startsWith('FS_')) {
      return new WslFsError(
        error instanceof Error ? error.message : String(error),
        candidate,
        error instanceof Error ? error : undefined,
      )
    }
  }
  return new WslFsError(
    error instanceof Error ? error.message : String(error),
    'FS_IO_ERROR',
    error instanceof Error ? error : undefined,
  )
}

/**
 * `ctx.fs` backed by one WSL distribution.
 *
 * The provider owns target identity (a canonical Linux path), path translation between the
 * two path spaces, and the error taxonomy. All file mutation semantics — realpath identity,
 * version tokens, atomic publication, literal edits with line-ending preservation — live
 * beside the data in the helper's `fsio` module and are only *driven* from here, so the host
 * never holds a second, subtly different implementation of a mutation rule.
 *
 * Constructed synchronously so a composition can register the service during `apply`: the
 * seam requires a provider before any Session exists, while provisioning and the `wsl.exe`
 * handshake stay on the first real operation through the lazy `connect`.
 *
 * The class is self-contained rather than extending the seam's `FileSystem`. Every method
 * the seam requires is defined here, `watch()` is implemented explicitly as a rejection, and
 * consumers use the service by shape — so extending would buy a dynamic import during
 * activation and a runtime prototype rewrite for no behavioral gain.
 *
 * Watching is deliberately unsupported: the reference SSH provider keeps the same
 * rejection rather than polling a remote path. A polling watcher would spend a round trip
 * per interval per target on the one control channel that carries every other operation.
 */

/**
 * Send one helper request, converting a helper failure into a provider-visible
 * `WslFsError`.
 *
 * Module-level so the async generator in `streamText`, which runs outside the instance's
 * private scope, can share it.
 *
 * @param {WslFileSystem} provider
 * @param {string} method
 * @param {object} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function call(provider, method, params, signal) {
  const connection = await provider.connection()
  try {
    return await connection.request(method, params, { signal })
  } catch (error) {
    throw asFsError(error)
  }
}

export class WslFileSystem {
  /** @type {Map<string, string>} targetKey -> canonical Linux path */
  #canonical = new Map()
  /** @type {Map<string, string>} targetKey -> display path */
  #display = new Map()
  #pending

  /**
   * @param {object} options
   * @param {() => Promise<import('./connection.js').WslConnection>} options.connect
   * @param {string} options.distro
   * @param {string} [options.cwd] fixed default base for relative paths
   * @param {() => Promise<string>} [options.defaultCwd]
   *   base resolved on demand, used when it is only known after connecting (the Linux home)
   */
  constructor(options) {
    this.connect = options.connect
    this.distro = options.distro
    /** An explicitly configured base, when the caller supplied one. */
    this.#explicitCwd = options.cwd
    /** Resolved base, cached after the first need. */
    this.cwd = options.cwd ?? '/'
    this.defaultCwd = options.defaultCwd
    this.#pending = undefined
  }

  /** @type {string|undefined} */
  #explicitCwd

  /**
   * The base a relative path resolves against.
   *
   * Resolved on demand so registering the provider performs no I/O, then cached. An
   * explicitly configured base wins outright.
   *
   * @private
   * @returns {Promise<string>}
   */
  async #baseCwd() {
    if (this.#explicitCwd !== undefined) return this.cwd
    if (this.defaultCwd !== undefined) this.cwd = await this.defaultCwd()
    return this.cwd
  }

  /**
   * The mode this backend enforces by default.
   *
   * A bare backend never confines, so this reports `undefined` — the honest fact the
   * tool layer reads before advertising escalation.
   *
   * @returns {undefined}
   */
  get sandboxMode() {
    return undefined
  }

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

  /** Release this provider's connection. */
  async dispose() {
    if (!this.#pending) return
    const connection = await this.#pending
    await connection.dispose()
  }

  /**
   * @private
   * @param {string} method
   * @param {object} params
   * @param {AbortSignal} [signal]
   */
  async #call(method, params, signal) {
    return call(this, method, params, signal)
  }
  /**
   * Translate one path into this execution world.
   *
   * @private
   * @param {string} path
   * @returns {string}
   */
  #translate(path) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new WslFsError('path must be a non-empty string', 'FS_IO_ERROR')
    }
    if (path.startsWith('/')) return path
    if (/^[A-Za-z]:/.test(path) || path.startsWith('\\\\') || path.startsWith('//')) {
      const translated = windowsToLinux(path)
      if (translated === undefined) {
        throw new WslFsError(`cannot map the Windows path ${path} into WSL`, 'FS_IO_ERROR')
      }
      return translated
    }
    return path
  }

  /**
   * Turn a caller-supplied path into an absolute Linux path.
   *
   * Windows paths — including a Windows `cwd` — are translated rather than rejected,
   * because the harness host and its model-facing tools naturally produce Windows paths when
   * a workspace was opened from the Windows side.
   *
   * `~` expands against the base BEFORE joining, so `~/x` reaches the Linux home instead of
   * becoming `/~/x`.
   *
   * @private
   * @param {string} path
   * @param {string} [cwd]
   * @returns {Promise<string>}
   */
  async #toLinuxPath(path, cwd) {
    const base = cwd === undefined ? await this.#baseCwd() : this.#translate(cwd)
    const raw = this.#translate(path)
    if (raw === '~' || raw.startsWith('~/')) {
      const home = await this.#baseCwd()
      return expandHome(raw, home).path
    }
    if (raw.startsWith('/')) return raw
    return joinLinux(base, raw)
  }

  /**
   * Resolve a path into a stable target.
   *
   * @param {string} path
   * @param {{cwd?: string, signal?: AbortSignal}} [opts]
   * @returns {Promise<{targetKey: string, displayPath: string}>}
   */
  async resolve(path, opts = {}) {
    const linux = await this.#toLinuxPath(path, opts.cwd)
    const result = await this.#call('fs.resolve', { path: linux, cwd: opts.cwd }, opts.signal)
    // The helper's canonical path is authoritative; the display path stays as the
    // caller wrote it so model-facing output is not rewritten behind their back.
    this.#canonical.set(result.targetKey, result.targetKey)
    this.#display.set(result.targetKey, result.displayPath)
    return { targetKey: result.targetKey, displayPath: result.displayPath }
  }

  /**
   * Absolute path a subprocess in this execution world can open.
   *
   * @param {{targetKey: string}} target
   * @returns {string}
   */
  processPath(target) {
    const canonical = this.#canonical.get(target.targetKey)
    if (canonical === undefined) {
      throw new WslFsError(
        'target was not produced by this provider; call resolve() first',
        'FS_IO_ERROR',
      )
    }
    return canonical
  }

  /**
   * Map a harness-host path into the distribution when the same file is reachable.
   *
   * @param {string} hostPath absolute Windows path
   * @returns {string|undefined}
   */
  processPathFromHostPath(hostPath) {
    return windowsToLinux(hostPath)
  }

  /**
   * Canonical `file:` URI in the execution world.
   *
   * This is an execution coordinate, not a host filesystem handle or a download link.
   *
   * @param {{targetKey: string}} target
   * @returns {string}
   */
  fileUrl(target) {
    return `file://${encodeURI(this.processPath(target)).replace(/[?#]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`
  }

  /**
   * Windows path for a target, for host-side UI that must open the real location.
   *
   * @param {{targetKey: string}} target
   * @returns {string|undefined}
   */
  hostPath(target) {
    return linuxToWindows(this.processPath(target), this.distro)
  }

  /**
   * Whether a target sits on a Windows drive mounted through drvfs.
   *
   * Callers should surface this: drvfs does not carry reliable POSIX `ctime`/inode
   * semantics, so the version guard is weaker for these paths.
   *
   * @param {{targetKey: string}} target
   * @returns {boolean}
   */
  isWindowsBacked(target) {
    return isWindowsBackedPath(this.processPath(target))
  }

  /**
   * Test canonical containment.
   *
   * @param {{targetKey: string}} parent
   * @param {{targetKey: string}} child
   * @returns {boolean}
   */
  contains(parent, child) {
    const root = this.processPath(parent).replace(/\/+$/, '')
    const candidate = this.processPath(child)
    return candidate === root || candidate.startsWith(`${root}/`)
  }

  /**
   * Observation is not supported in this execution world.
   *
   * The reference SSH provider keeps the base class's rejection rather than opening a
   * local watcher for a remote path, and this provider does the same. A watcher that
   * worked by polling would spend a round trip per interval per target on the same
   * single control channel that carries every other operation, so refusing is the
   * honest answer. Consumers keep ordinary reads and their own manual refresh.
   *
   * @returns {Promise<never>}
   * @throws {WslFsError} with `FS_IO_ERROR`
   */
  async watch() {
    throw new WslFsError(
      'filesystem watching is not supported in a WSL execution world',
      'FS_IO_ERROR',
    )
  }

  /**
   * Metadata for a target, or undefined when absent.
   *
   * @param {{targetKey: string}} target
   * @param {AbortSignal} [signal]
   * @returns {Promise<{version: string, type: string, size?: number}|undefined>}
   */
  async stat(target, signal) {
    const { info } = await this.#call('fs.stat', { targetKey: target.targetKey }, signal)
    return info ?? undefined
  }

  /**
   * Path-shaped metadata that does not follow a final symlink.
   *
   * @param {string} path
   * @param {{cwd?: string}} [opts]
   * @param {AbortSignal} [signal]
   * @returns {Promise<{version: string, type: string, size?: number}|undefined>}
   */
  async lstat(path, opts = {}, signal) {
    const linux = await this.#toLinuxPath(path, opts.cwd)
    const { info } = await this.#call('fs.lstat', { path: linux, cwd: opts.cwd }, signal)
    return info ?? undefined
  }

  /**
   * Whole-file UTF-8 text, with the helper's binary rejection preserved.
   *
   * @param {{targetKey: string}} target
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async readText(target, signal) {
    const { text } = await this.#call(
      'fs.readText',
      { targetKey: target.targetKey, maxBytes: WHOLE_TEXT_READ_LIMIT },
      signal,
    )
    return text
  }

  /**
   * Stream decoded text in bounded windows.
   *
   * @param {{targetKey: string}} target
   * @param {AbortSignal} [signal]
   * @returns {Promise<AsyncIterable<string>>}
   */
  async streamText(target, signal) {
    const info = await this.stat(target, signal)
    if (info === undefined) {
      throw new WslFsError(`no such file: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'file') {
      throw new WslFsError(`${target.displayPath} is not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const total = info.size ?? 0
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        let offset = 0
        while (offset < total) {
          if (signal?.aborted) throw new WslFsError('read aborted', 'FS_ABORTED')
          const length = Math.min(STREAM_CHUNK_BYTES, total - offset)
          const { text } = await call(
            self,
            'fs.readTextWindow',
            { targetKey: target.targetKey, offset, length },
            signal,
          )
          offset += length
          if (text.length > 0) yield text
        }
      },
    }
  }

  /**
   * Whole-file raw bytes with an inclusive cap.
   *
   * @param {{targetKey: string}} target
   * @param {AbortSignal|undefined} signal
   * @param {number} maxBytes
   * @returns {Promise<Uint8Array>}
   */
  async readBytes(target, signal, maxBytes) {
    const { base64 } = await this.#call(
      'fs.readBytes',
      { targetKey: target.targetKey, maxBytes },
      signal,
    )
    return Uint8Array.from(Buffer.from(base64, 'base64'))
  }

  /**
   * One byte window, without buffering the whole file.
   *
   * @param {{targetKey: string}} target
   * @param {{offset: number, length: number}} range
   * @param {AbortSignal} [signal]
   * @returns {Promise<Uint8Array>}
   */
  async readByteRange(target, range, signal) {
    const { base64 } = await this.#call(
      'fs.readByteRange',
      { targetKey: target.targetKey, offset: range.offset, length: range.length },
      signal,
    )
    return Uint8Array.from(Buffer.from(base64, 'base64'))
  }

  /**
   * One directory level in stable name order.
   *
   * @param {{targetKey: string}} target
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{name: string, type: string, target: object, version?: string, size?: number}>>}
   */
  async listDir(target, signal) {
    const { entries } = await this.#call('fs.listDir', { targetKey: target.targetKey }, signal)
    return entries.map((entry) => {
      this.#canonical.set(entry.path, entry.path)
      this.#display.set(entry.path, `${target.displayPath.replace(/\/+$/, '')}/${entry.name}`)
      return {
        name: entry.name,
        type: entry.type,
        target: { targetKey: entry.path, displayPath: this.#display.get(entry.path) },
        version: entry.version,
        size: entry.size,
      }
    })
  }

  /**
   * Atomically create or replace text.
   *
   * @param {{targetKey: string, displayPath: string}} target
   * @param {string} content
   * @param {{kind: 'createIfAbsent'}|{kind: 'replaceIfVersion', version: string}} [expected]
   * @param {AbortSignal} [signal]
   * @param {{mode?: string, workspaceRoot?: string}} [sandboxPolicy] ignored by this bare backend
   * @returns {Promise<{operation: string, version: string, before: string|null, after: string}>}
   */
  async writeText(target, content, expected, signal, sandboxPolicy) {
    if (signal?.aborted) throw new WslFsError('write aborted', 'FS_ABORTED')
    // The bare backend does not confine: `sandboxPolicy` is accepted and ignored,
    // exactly as the seam documents. Confinement is the sandbox provider's job.
    void sandboxPolicy
    const result = await this.#call(
      'fs.writeText',
      {
        targetKey: target.targetKey,
        displayPath: target.displayPath,
        content,
        expected: expected === undefined ? undefined : { ...expected },
      },
      signal,
    )
    return result
  }

  /**
   * Atomically apply a literal edit.
   *
   * @param {{targetKey: string, displayPath: string}} target
   * @param {{oldString: string, newString: string, replaceAll: boolean}} edit
   * @param {{version: string}} [expected]
   * @param {AbortSignal} [signal]
   * @param {{mode?: string, workspaceRoot?: string}} [sandboxPolicy] ignored by this bare backend
   * @returns {Promise<{version: string, before: string, after: string}>}
   */
  async editText(target, edit, expected, signal, sandboxPolicy) {
    if (signal?.aborted) throw new WslFsError('edit aborted', 'FS_ABORTED')
    void sandboxPolicy
    return this.#call(
      'fs.editText',
      {
        targetKey: target.targetKey,
        displayPath: target.displayPath,
        edit: { ...edit },
        expected: expected === undefined ? undefined : { ...expected },
      },
      signal,
    )
  }

  /**
   * Recursively list regular files under a target, bounded.
   *
   * A convenience beyond the seam, used by discovery consumers so the walk happens
   * beside the data instead of streaming a whole tree across the wire.
   *
   * @param {{targetKey: string}} target
   * @param {{maxEntries?: number, maxDepth?: number, includeHidden?: boolean, signal?: AbortSignal}} [options]
   * @returns {Promise<{files: Array<{path: string, size: number}>, truncated: boolean}>}
   */
  async walkFiles(target, options = {}) {
    return this.#call(
      'fs.walk',
      {
        targetKey: target.targetKey,
        maxEntries: options.maxEntries,
        maxDepth: options.maxDepth,
        includeHidden: options.includeHidden,
      },
      options.signal,
    )
  }
}
