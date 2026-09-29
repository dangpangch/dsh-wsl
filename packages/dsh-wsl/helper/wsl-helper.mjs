#!/usr/bin/env node
/**
 * dsh-wsl Linux helper: the only dsh-wsl process that runs inside the distribution.
 *
 * It owns no Harness state. It answers administrative requests over framed stdio
 * and hosts the managed ranges (files, processes, terminals) that the Windows-side
 * providers drive. The host runs the Harness, model transport and Session storage;
 * this helper supplies files and processes, mirroring the reference SSH helper.
 *
 * Lifecycle
 * ---------
 * The helper expires its own lease when host heartbeats stop, so a host that dies
 * without a clean shutdown still gets its managed ranges torn down rather than
 * leaking processes inside the distribution.
 *
 * Deployment
 * ----------
 * This file is copied into the distribution beside its protocol module and launched
 * by an absolute Node path. Keep its imports inside this pair: it is deployed as
 * loose files, not installed as a package.
 *
 * @module @local/dsh-wsl/helper
 */
import { spawn as spawnProcess } from 'node:child_process'
import {
  accessSync,
  appendFileSync,
  constants as FS_CONSTANTS,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import {
  FrameDecoder,
  FrameType,
  HelperError,
  HelperErrorCode,
  PROTOCOL_VERSION,
  encodeFrame,
  helloMessage,
} from './protocol.js'
import {
  canonicalize,
  editText as fsioEditText,
  listDir as fsioListDir,
  probe,
  probePath,
  readByteRange,
  readBytes,
  readText,
  toAbsolute,
  walkFiles,
  writeText as fsioWriteText,
} from './fsio.mjs'

/** Default host-liveness window before the helper tears itself down. */
const DEFAULT_LEASE_MS = 60_000

/* -------------------------------------------------------------------------- */
/* transport                                                                  */
/* -------------------------------------------------------------------------- */

/** Serializes frame writes so concurrent handlers cannot interleave length prefixes. */
class FrameWriter {
  #count = 0

  /** @param {NodeJS.WritableStream} stream */
  constructor(stream) {
    this.stream = stream
  }

  /**
   * @param {object} message JSON-serializable frame
   * @returns {Promise<void>|undefined} a promise only when the stream is saturated
   */
  write(message) {
    const frame = encodeFrame(message)
    this.#count += 1
    if (this.stream.write(frame)) return undefined
    // Backpressure: wait for drain so the channel cannot grow without bound.
    return new Promise((resolve) => this.stream.once('drain', resolve))
  }

  /** Frames written so far; diagnostics only. */
  get count() {
    return this.#count
  }
}

/* -------------------------------------------------------------------------- */
/* lease                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Tracks host liveness. Without this, in-distro processes and terminals would
 * outlive the session that owns them whenever the host crashes.
 */
class Lease {
  #refresh = undefined
  #deadline = undefined
  #expired = false

  /**
   * @param {number} leaseMs window without a heartbeat before expiry
   * @param {() => void} onExpiry called exactly once when the lease expires
   */
  constructor(leaseMs, onExpiry) {
    this.leaseMs = leaseMs
    this.onExpiry = onExpiry
    this.touch()
  }

  /** Restart the lease window. Called on every frame received from the host. */
  touch() {
    if (this.#expired) return
    clearTimeout(this.#refresh)
    clearTimeout(this.#deadline)
    // Refresh at a third of the window so one dropped beat cannot expire the lease
    // while the deadline still measures real host silence.
    const interval = Math.max(250, Math.floor(this.leaseMs / 3))
    this.#refresh = setTimeout(() => this.touch(), interval)
    this.#deadline = setTimeout(() => {
      this.#expired = true
      this.onExpiry()
    }, this.leaseMs)
    this.#refresh.unref?.()
    this.#deadline.unref?.()
  }

  /** Stop renewing; used during orderly shutdown. */
  stop() {
    this.#expired = true
    clearTimeout(this.#refresh)
    clearTimeout(this.#deadline)
  }
}

/* -------------------------------------------------------------------------- */
/* managed ranges                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Owns everything the helper allocated on behalf of the host.
 *
 * Later milestones add process groups, PTY sessions and file watchers here. One
 * teardown path matters because disposal must be idempotent and must await real
 * quiescence: the host cannot confirm a remote outcome after disconnect.
 */
class ManagedRanges {
  /** @type {Set<() => Promise<void>>} */
  #disposals = new Set()
  #disposed = false

  /**
   * Register a cleanup step owned by the helper's lifetime.
   *
   * @param {() => void | Promise<void>} dispose idempotent teardown
   * @returns {() => Promise<void>} runs this step once
   */
  add(dispose) {
    let done = false
    const run = async () => {
      if (done) return
      done = true
      this.#disposals.delete(run)
      await dispose()
    }
    this.#disposals.add(run)
    return run
  }

  /** Tear down every managed range, awaiting each and tolerating individual failure. */
  async disposeAll() {
    if (this.#disposed) return
    this.#disposed = true
    const pending = [...this.#disposals]
    this.#disposals.clear()
    await Promise.allSettled(pending.map((run) => run()))
  }

  /** Live managed ranges; diagnostics only. */
  get size() {
    return this.#disposals.size
  }
}

/* -------------------------------------------------------------------------- */
/* collected output                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Bounded, offset-addressed collector for one stream.
 *
 * Offsets are whole-stream BYTE coordinates while the exposed text is decoded
 * UTF-8; both are tracked on the one buffer so a read can never report an offset
 * that disagreed with the text it returned.
 */
class StreamCollector {
  #chunks = []
  #bytes = 0
  #text = ''
  #spillPath
  #spillBytes = 0
  #truncated = false
  #spillCap

  /**
   * @param {number} maxBytes in-memory cap; overflow keeps the tail
   */
  constructor(maxBytes) {
    this.maxBytes = maxBytes
  }

  /**
   * Begin writing the complete stream to a spill file.
   *
   * @param {string} spillPath destination file
   * @param {number|undefined} cap whole-stream byte cap; a larger stream discards its
   *   now-incomplete spill, which is why the cap is checked on every append
   */
  enableSpill(spillPath, cap) {
    this.#spillPath = spillPath
    this.#spillCap = cap
    this.#spillBytes = 0
  }

  /** Total bytes ever received, including those already dropped from the tail. */
  get byteLength() {
    return this.#bytes
  }

  /** Path of the spill file when one is intact, otherwise undefined. */
  get spillPath() {
    return this.#spillPath
  }

  /**
   * Append one chunk.
   *
   * @param {Buffer} chunk
   */
  push(chunk) {
    this.#bytes += chunk.length

    if (this.#spillPath !== undefined) {
      this.#spillBytes += chunk.length
      if (this.#spillCap !== undefined && this.#spillBytes > this.#spillCap) {
        // A stream past its whole-stream cap discards its now-incomplete spill.
        try {
          rmSync(this.#spillPath, { force: true })
        } catch {
          /* best effort */
        }
        this.#spillPath = undefined
      } else {
        try {
          appendFileSync(this.#spillPath, chunk)
        } catch {
          this.#spillPath = undefined
        }
      }
    }

    this.#chunks.push(chunk)
    this.#text += chunk.toString('utf8')
    // Keep the in-memory tail bounded; the head is only recoverable by offset from
    // the spill file, which is exactly the documented `lossy` semantics.
    while (Buffer.byteLength(this.#text, 'utf8') > this.maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift()
      this.#text = this.#text.slice(dropped.toString('utf8').length)
      this.#truncated = true
    }
  }

  /**
   * Read everything since a whole-stream byte offset.
   *
   * @param {number} fromByte
   * @returns {{text: string, nextOffset: number, lossy: boolean, spillPath?: string}}
   */
  readFrom(fromByte) {
    const retainedFrom = this.#bytes - Buffer.byteLength(this.#text, 'utf8')
    if (fromByte < retainedFrom) {
      return {
        text: this.#text,
        nextOffset: this.#bytes,
        lossy: true,
        spillPath: this.#spillPath,
      }
    }
    const skip = fromByte - retainedFrom
    const text = skip <= 0 ? this.#text : this.#text.slice(skip)
    return { text, nextOffset: this.#bytes, lossy: false, spillPath: this.#spillPath }
  }
}

/* -------------------------------------------------------------------------- */
/* managed child processes                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Owns the child processes the host spawned, so helper shutdown can end them.
 *
 * Every process is registered as a managed range: a host that dies without a clean
 * shutdown must not leave work running inside the distribution beyond the lease.
 *
 * @param {ManagedRanges} ranges
 * @param {Map<string, ManagedProcess>} table
 */
function createProcessTable(ranges, table) {
  let nextPid = 1

  return {
    /**
     * Spawn one managed child.
     *
     * @param {object} params
     * @returns {{id: string, pid: number|undefined}}
     */
    spawn(params) {
      const {
        argv,
        cwd,
        env = {},
        stdin = 'ignore',
        stdinData,
        stdout = 'collect',
        stderr = 'collect',
        graceMs = 3000,
        maxBytes = 1 << 20,
      } = params

      if (!Array.isArray(argv) || argv.length === 0) {
        throw new HelperError(HelperErrorCode.INVALID_PARAMS, 'argv must be a non-empty array')
      }

      // `data` is the batch shape: the bytes are delivered up front and stdin then
      // closes, so it needs a pipe exactly like the ongoing `pipe` shape.
      const wantStdinPipe = stdin === 'pipe' || stdin === 'data'
      const stdoutIsCollect = typeof stdout === 'object' && stdout !== null
      const stderrIsCollect = typeof stderr === 'object' && stderr !== null

      const child = spawnProcess(argv[0], argv.slice(1), {
        cwd,
        env,
        stdio: [
          wantStdinPipe ? 'pipe' : 'ignore',
          stdout === 'inherit' || stdout === 'pipe' ? 'pipe' : 'pipe',
          stderr === 'inherit' ? 'inherit' : 'pipe',
        ],
        // A new process group lets termination reach the whole range rather than
        // only the direct child, which is what `waitForExit` must observe.
        detached: true,
      })

      const id = `p${nextPid++}`
      /** @type {ManagedProcess} */
      const managed = {
        id,
        child,
        stdout: stdoutIsCollect ? new StreamCollector(stdout.maxBytes ?? maxBytes) : undefined,
        stderr: stderrIsCollect ? new StreamCollector(stderr.maxBytes ?? maxBytes) : undefined,
        outcome: undefined,
        waiters: [],
        terminated: false,
      }

      if (managed.stdout && typeof stdout.spillPath === 'string') {
        managed.stdout.enableSpill(stdout.spillPath, stdout.spillMaxBytes)
      }
      if (managed.stderr && typeof stderr.spillPath === 'string') {
        managed.stderr.enableSpill(stderr.spillPath, stderr.spillMaxBytes)
      }

      child.stdout?.on('data', (chunk) => managed.stdout?.push(chunk))
      child.stderr?.on('data', (chunk) => managed.stderr?.push(chunk))

      // Deliver batch stdin up front and close it, so the child sees EOF.
      if (wantStdinPipe && typeof stdinData === 'string') {
        child.stdin?.end(stdinData)
      }

      const release = ranges.add(async () => {
        await terminateManaged(managed, graceMs)
        table.delete(id)
      })
      managed.release = release

      child.on('error', (error) => {
        managed.spawnError = error
        managed.outcome = { exitCode: null, signal: null }
        for (const waiter of managed.waiters.splice(0)) waiter()
      })
      child.on('close', (code, signal) => {
        managed.outcome = { exitCode: code, signal: signal ?? null }
        for (const waiter of managed.waiters.splice(0)) waiter()
      })

      table.set(id, managed)
      return { id, pid: child.pid }
    },

    /** Resolve a live process or fail with a stable NOT_FOUND code. */
    require(id) {
      const managed = table.get(id)
      if (!managed) {
        throw new HelperError(HelperErrorCode.NOT_FOUND, `no managed process "${id}"`)
      }
      return managed
    },

    table,
  }
}

/**
 * @typedef {object} ManagedProcess
 * @property {string} id
 * @property {import('node:child_process').ChildProcess} child
 * @property {StreamCollector|undefined} stdout
 * @property {StreamCollector|undefined} stderr
 * @property {{exitCode: number|null, signal: string|null}|undefined} outcome
 * @property {(() => void)[]} waiters
 * @property {boolean} terminated
 * @property {Error|undefined} spawnError
 * @property {() => Promise<void>} release
 */

/**
 * Terminate a managed process range: TERM to the group, then KILL after the grace.
 *
 * Signalling the whole group is what makes the range — not just the direct child —
 * quiescent, which is the fact `waitForExit` promises to observe.
 *
 * @param {ManagedProcess} managed
 * @param {number} graceMs
 * @returns {Promise<void>}
 */
async function terminateManaged(managed, graceMs) {
  if (managed.terminated) return
  managed.terminated = true

  const pid = managed.child.pid
  if (managed.outcome) return
  if (pid === undefined) return

  const signalGroup = (signal) => {
    try {
      // Negative pid addresses the group created by `detached: true`.
      process.kill(-pid, signal)
    } catch {
      try {
        managed.child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }

  signalGroup('SIGTERM')
  const exited = await waitForOutcome(managed, graceMs)
  if (!exited) {
    signalGroup('SIGKILL')
    await waitForOutcome(managed, graceMs)
  }
}

/**
 * Await a process outcome with a bound.
 *
 * @param {ManagedProcess} managed
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when the outcome arrived in time
 */
function waitForOutcome(managed, timeoutMs) {
  if (managed.outcome) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs))
    timer.unref?.()
    managed.waiters.push(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/* -------------------------------------------------------------------------- */
/* system facts                                                               */
/* -------------------------------------------------------------------------- */

/** Read `/etc/os-release`; an absent or unreadable file yields an empty record. */
function readOsRelease() {
  try {
    /** @type {Record<string,string>} */
    const out = {}
    for (const line of readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (!match) continue
      out[match[1]] = match[2].replace(/^"|"$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

/** Parse `/proc/mounts` into the mount points a workspace might live on. */
function readMounts() {
  try {
    return readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [device, mountPoint, fstype] = line.split(' ')
        return { device, mountPoint, fstype }
      })
      .filter((m) => m.fstype !== 'proc' && m.fstype !== 'sysfs' && m.fstype !== 'devpts')
      .slice(0, 64)
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* methods                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Administrative methods: the helper's control plane.
 *
 * Bulk payloads and long-lived program streams use separate channels once later
 * milestones add them, so a program's stdout can never be mistaken for an
 * administrative reply.
 *
 * @param {ManagedRanges} ranges
 */
function createMethods(ranges) {
  /** @type {Map<string, ManagedProcess>} */
  const processes = new Map()
  const procs = createProcessTable(ranges, processes)

  return {
    /** Liveness and identity. Awaiting this proves the launched helper is the installed one. */
    probe: () => ({
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      execPath: process.execPath,
    }),

    /**
     * Kernel and distribution facts. Reporting a Linux `sysname` here is the single
     * acceptance signal that work happens inside the distribution, not on Windows.
     */
    uname: () => ({
      sysname: os.type(),
      release: os.release(),
      machine: os.arch(),
      hostname: os.hostname(),
      distro: readOsRelease(),
    }),

    /** Identity and home resolution for the user the helper runs as. */
    user: () => {
      const info = os.userInfo()
      return {
        username: info.username,
        uid: info.uid,
        gid: info.gid,
        home: os.homedir(),
        shell: process.env.SHELL ?? null,
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? null,
          WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME ?? null,
          WSL_INTEROP: process.env.WSL_INTEROP ?? null,
        },
      }
    },

    /** Resource facts, so later limits are sized from measurement rather than guesses. */
    resources: () => ({
      cpus: os.cpus().length,
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      tmpdir: os.tmpdir(),
      mounts: readMounts(),
    }),

    /**
     * Exercise the managed-range path before any real range depends on it: register a
     * no-op, release it, and report the live count on either side of the release.
     */
    'ranges.probe': async () => {
      const release = ranges.add(() => {})
      const liveDuring = ranges.size
      await release()
      return { liveDuring, liveAfter: ranges.size }
    },

    /* ---------------------------------------------------------------------- */
    /* execution world                                                        */
    /* ---------------------------------------------------------------------- */

    /**
     * Executable lookup in this execution world.
     *
     * A bare name resolves against PATH; an absolute path is verified to be an
     * executable file; a relative path containing a separator is refused, because
     * its resolution base would be a guess.
     */
    'exec.resolve': ({ command, env }) => {
      if (typeof command !== 'string' || command.length === 0) {
        throw new HelperError(HelperErrorCode.INVALID_PARAMS, 'command must be a non-empty string')
      }
      const searchPath = env?.PATH ?? process.env.PATH ?? ''
      return { path: resolveExecutable(command, searchPath) }
    },

    /** Shell-selection facts for the terminal consumer. */
    'terminal.env': () => {
      const candidates = ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/zsh', '/usr/bin/fish']
      const found = candidates.find((candidate) => existsExecutable(candidate))
      return { platform: 'posix', defaultShell: process.env.SHELL ?? found ?? '/bin/sh' }
    },

    /** Start one managed child process. */
    'process.spawn': (params) => procs.spawn(params),

    /** Write to a managed process's stdin. */
    'process.write': ({ id, data }) => {
      const managed = procs.require(id)
      if (!managed.child.stdin?.writable) {
        throw new HelperError(
          HelperErrorCode.INVALID_PARAMS,
          `process "${id}" was not spawned with piped stdin`,
        )
      }
      managed.child.stdin.write(data)
      return { written: Buffer.byteLength(data, 'utf8') }
    },

    /** Close a managed process's stdin without terminating it. */
    'process.endStdin': ({ id }) => {
      procs.require(id).child.stdin?.end()
      return { ended: true }
    },

    /** Read collected output since a whole-stream byte offset. */
    'process.read': ({ id, stream, fromByte }) => {
      const managed = procs.require(id)
      const collector = stream === 'stderr' ? managed.stderr : managed.stdout
      if (!collector) {
        throw new HelperError(
          HelperErrorCode.INVALID_PARAMS,
          `process "${id}" has no collected ${stream} stream`,
        )
      }
      return collector.readFrom(fromByte ?? 0)
    },

    /** Exit facts, when the range has already emptied. */
    'process.poll': ({ id }) => ({ outcome: procs.require(id).outcome ?? null }),

    /**
     * Wait for the managed range to empty.
     *
     * The caller may allow this to outlast the administrative deadline, because a
     * legitimate long-running command must not be cut short by an RPC timeout.
     */
    'process.wait': ({ id, timeoutMs }) => {
      const managed = procs.require(id)
      return waitForOutcome(managed, timeoutMs ?? 30_000).then((exited) => ({
        exited,
        outcome: managed.outcome ?? null,
      }))
    },

    /** Terminate a managed process range: TERM to the group, then KILL after the grace. */
    'process.terminate': async ({ id, graceMs }) => {
      const managed = procs.require(id)
      await terminateManaged(managed, graceMs ?? 3000)
      return { outcome: managed.outcome ?? null }
    },

    /** Release a completed managed process so its reservation is not retained. */
    'process.release': async ({ id }) => {
      await procs.require(id).release()
      return { released: true }
    },

    /* ---------------------------------------------------------------------- */
    /* filesystem                                                             */
    /* ---------------------------------------------------------------------- */

    /**
     * Resolve a path into a stable target.
     *
     * The key is the canonical path, so two input paths reaching the same file
     * through different symlinks share one identity — the property guarded writes
     * depend on to detect a change.
     */
    'fs.resolve': async ({ path, cwd }) => {
      const absolute = toAbsolute(path, cwd)
      const { path: canonical, info } = await canonicalize(absolute)
      targets.set(canonical, path)
      return {
        targetKey: canonical,
        displayPath: path,
        exists: info !== undefined,
        info: info
          ? { version: versionOf(info), type: kindOf(info), size: info.isFile() ? info.size : undefined }
          : undefined,
      }
    },

    /** Metadata for a resolved target; null when it is absent. */
    'fs.stat': async ({ targetKey }) => {
      const info = await probe(targetKey)
      return { info: info ?? null }
    },

    /** Path-shaped metadata that does not follow a final symlink; null when absent. */
    'fs.lstat': async ({ path, cwd }) => {
      const info = await probePath(toAbsolute(path, cwd))
      return { info: info ?? null }
    },

    /** Whole-file UTF-8 text with binary rejection. */
    'fs.readText': async ({ targetKey, maxBytes }) =>
      ({ text: await readText(targetKey, { maxBytes, displayPath: displayOf(targetKey) }) }),

    /** Whole-file raw bytes with an inclusive cap. */
    'fs.readBytes': async ({ targetKey, maxBytes }) => {
      const bytes = await readBytes(targetKey, maxBytes, { displayPath: displayOf(targetKey) })
      return { base64: bytes.toString('base64'), length: bytes.length }
    },

    /** One byte window with no whole-file buffering. */
    'fs.readByteRange': async ({ targetKey, offset, length }) => {
      const bytes = await readByteRange(targetKey, offset, length, {
        displayPath: displayOf(targetKey),
      })
      return { base64: bytes.toString('base64'), length: bytes.length }
    },

    /**
     * One decoded text window.
     *
     * Exists so a large text file can be streamed in bounded pieces instead of
     * crossing the wire whole; the host assembles the chunk iterable from these.
     */
    'fs.readTextWindow': async ({ targetKey, offset, length }) => {
      const bytes = await readByteRange(targetKey, offset, length, {
        displayPath: displayOf(targetKey),
      })
      // Decode leniently: a window can split a multi-byte character, and the caller
      // stitches windows, so a partial tail is expected rather than an error.
      return { text: bytes.toString('utf8'), length: bytes.length }
    },

    /** One directory level, stable name order, no content reads. */
    'fs.listDir': async ({ targetKey }) => {
      const entries = await fsioListDir(targetKey)
      for (const entry of entries) targets.set(entry.path, entry.name)
      return { entries }
    },

    /** Atomic create-or-replace with an optional guard. */
    'fs.writeText': async ({ targetKey, displayPath, content, expected, diffBasisMaxBytes }) => {
      const result = await fsioWriteText({
        absolute: targetKey,
        displayPath: displayPath ?? displayOf(targetKey),
        content,
        expected,
        diffBasisMaxBytes,
      })
      return result
    },

    /** Atomic literal edit with an optional version guard. */
    'fs.editText': async ({ targetKey, displayPath, edit, expected }) => {
      const result = await fsioEditText({
        absolute: targetKey,
        displayPath: displayPath ?? displayOf(targetKey),
        edit,
        expected,
      })
      return result
    },

    /** Bounded recursive walk, so discovery happens beside the data. */
    'fs.walk': async ({ targetKey, maxEntries, maxDepth, includeHidden }) => {
      const files = await walkFiles(targetKey, { maxEntries, maxDepth, includeHidden })
      return { files, truncated: files.length >= (maxEntries ?? 20_000) }
    },
  }
}

/** Paths the host has resolved, for diagnostics and display-path recovery. */
const targets = new Map()

/**
 * Recover a display path for a canonical path the host already sent.
 *
 * @param {string} targetKey
 * @returns {string}
 */
function displayOf(targetKey) {
  return targets.get(targetKey) ?? targetKey
}

/**
 * @param {import('node:fs').Stats} info
 * @returns {'file'|'directory'|'other'}
 */
function kindOf(info) {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

/**
 * Opaque version token: device, inode, size and both nanosecond timestamps.
 *
 * `ctime` is included so a rewrite that preserves size and mtime is still detected.
 *
 * @param {import('node:fs').Stats} info
 * @returns {string}
 */
function versionOf(info) {
  return [
    info.dev,
    info.ino,
    info.size,
    Math.trunc(info.mtimeMs * 1e6),
    Math.trunc(info.ctimeMs * 1e6),
  ].join(':')
}

/* -------------------------------------------------------------------------- */
/* executable resolution                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve one executable the way a POSIX shell would.
 *
 * @param {string} command absolute path or bare name
 * @param {string} searchPath colon-separated PATH
 * @returns {string} canonical absolute path
 * @throws {HelperError} with NOT_FOUND when nothing matches
 */
function resolveExecutable(command, searchPath) {
  if (command.includes('/')) {
    // A path with a separator is explicit: verify it rather than searching.
    if (!command.startsWith('/')) {
      throw new HelperError(
        HelperErrorCode.INVALID_PARAMS,
        `relative executable paths are rejected: ${command}`,
      )
    }
    if (existsExecutable(command)) return command
    throw new HelperError(HelperErrorCode.NOT_FOUND, `not an executable file: ${command}`)
  }
  for (const dir of searchPath.split(':')) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    if (existsExecutable(candidate)) return candidate
  }
  throw new HelperError(HelperErrorCode.NOT_FOUND, `"${command}" was not found on PATH`)
}

/**
 * Test whether a path is an executable regular file.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function existsExecutable(candidate) {
  try {
    const info = statSync(candidate)
    if (!info.isFile()) return false
    accessSync(candidate, FS_CONSTANTS.X_OK)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* server                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run the helper against the current process's stdio.
 *
 * @param {{leaseMs?: number}} [options]
 * @returns {Promise<void>} resolves after teardown completes
 */
export async function runHelper(options = {}) {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const writer = new FrameWriter(process.stdout)
  const decoder = new FrameDecoder()
  const ranges = new ManagedRanges()
  const methods = createMethods(ranges)

  let closing = false
  /** @type {() => void} */
  let resolveDone = () => {}
  const done = new Promise((resolve) => (resolveDone = resolve))

  /**
   * Send one frame, tolerating a closed transport: a write after the host is gone is
   * not actionable and must not throw into a request handler.
   */
  const send = async (message) => {
    try {
      await writer.write(message)
    } catch {
      void shutdown('transport closed', 0)
    }
  }

  const shutdown = async (reason, exitCode) => {
    if (closing) return
    closing = true
    lease.stop()
    // Tear down managed ranges BEFORE releasing the transport, so a host that is
    // still reading sees teardown complete rather than racing the process exit.
    await ranges.disposeAll()
    await send({ type: FrameType.SHUTDOWN, reason })
    try {
      process.stdin.pause()
    } catch {
      /* the transport may already be gone */
    }
    resolveDone()
    // Exit explicitly: pending stream handles must not keep the helper alive.
    process.exit(exitCode)
  }

  const lease = new Lease(leaseMs, () => {
    void shutdown(`lease expired after ${leaseMs} ms without a heartbeat`, 0)
  })

  // Announce identity first: the host refuses a mismatched protocol rather than
  // discovering the problem on the first real operation.
  await send(helloMessage({ helper: '@local/dsh-wsl/helper' }))

  const handle = async (message) => {
    lease.touch()

    if (message.type === FrameType.HEARTBEAT) return
    if (message.type === FrameType.SHUTDOWN) {
      await shutdown('host requested shutdown', 0)
      return
    }
    if (message.type !== FrameType.REQUEST) {
      await send({
        type: FrameType.ERROR,
        id: message.id ?? null,
        code: HelperErrorCode.BAD_FRAME,
        message: `unexpected frame type ${String(message.type)}`,
      })
      return
    }

    const { id, method, params } = message
    const handler = methods[method]
    if (typeof handler !== 'function') {
      await send({
        type: FrameType.ERROR,
        id,
        code: HelperErrorCode.UNKNOWN_METHOD,
        message: `unknown method ${String(method)}`,
      })
      return
    }

    try {
      const result = await handler(params, { ranges, send, shutdown })
      await send({ type: FrameType.RESPONSE, id, result })
    } catch (error) {
      const code = error instanceof HelperError ? error.code : HelperErrorCode.INTERNAL
      // A filesystem failure carries its own harness error code, which is outside
      // this transport's narrow code vocabulary. Forward it as `appCode` so the host
      // can rethrow the real `FS_*` code instead of flattening every domain failure
      // into INTERNAL.
      const raw = /** @type {{code?: unknown}} */ (error)?.code
      const appCode = typeof raw === 'string' && raw !== code ? raw : undefined
      await send({
        type: FrameType.ERROR,
        id,
        code,
        appCode,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof HelperError ? error.details : undefined,
      })
    }
  }

  // Process frames strictly in arrival order: administrative requests are ordered by
  // design, and later stream work runs outside this queue.
  process.stdin.on('data', (chunk) => {
    let messages
    try {
      messages = decoder.push(chunk)
    } catch (error) {
      const code = error instanceof HelperError ? error.code : HelperErrorCode.BAD_FRAME
      void send({
        type: FrameType.ERROR,
        id: null,
        code,
        message: error instanceof Error ? error.message : String(error),
      }).then(() => shutdown('malformed frame; the stream cannot be resynchronized', 2))
      return
    }
    for (const message of messages) void handle(message)
  })

  // A closed stdin means the host went away; tear down rather than linger.
  process.stdin.on('end', () => void shutdown('stdin closed', 0))
  process.stdin.on('error', () => void shutdown('stdin error', 0))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
  process.on('SIGINT', () => void shutdown('SIGINT', 0))

  await done
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) await runHelper()
