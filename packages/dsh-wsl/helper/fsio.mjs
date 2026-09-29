/**
 * Cordis-free filesystem primitives for the in-distribution helper.
 *
 * Deliberately separate from the helper's transport and dispatch so the semantics
 * that make `ctx.fs` trustworthy — realpath identity, version tokens, atomic
 * publication, literal edits with line-ending preservation — are implemented and
 * reasoned about in one place, without any Harness dependency.
 *
 * Error codes match the harness vocabulary so the host can rethrow them without
 * translating: `FS_NOT_FOUND`, `FS_NOT_DIRECTORY`, `FS_NOT_TEXT`,
 * `FS_NOT_REGULAR_FILE`, `FS_TOO_LARGE`, `FS_PERMISSION_DENIED`, `FS_IO_ERROR`,
 * `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_AMBIGUOUS_EDIT`, `FS_EDIT_NOT_FOUND`.
 *
 * @module @local/dsh-wsl/helper/fsio
 */
import { constants as FS_CONSTANTS } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve as resolvePath, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Bytes sampled from the head when deciding whether a file is text. */
const BINARY_SAMPLE_BYTES = 8192

/**
 * A filesystem failure carrying a stable code from the harness vocabulary.
 *
 * The host rethrows these verbatim, so callers branch on `code` and never on
 * message text.
 */
export class FsioError extends Error {
  /**
   * @param {string} message human-readable detail
   * @param {string} code one of the harness `FsErrorCode` values
   * @param {unknown} [cause]
   */
  constructor(message, code, cause) {
    super(message)
    this.name = 'FsioError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Map a Node filesystem errno to a harness error code.
 *
 * @param {unknown} error
 * @param {string} fallbackCode code used for an unrecognized failure
 * @returns {FsioError}
 */
export function wrapFsError(error, fallbackCode = 'FS_IO_ERROR') {
  if (error instanceof FsioError) return error
  const errno = /** @type {NodeJS.ErrnoException} */ (error)?.code
  const code =
    errno === 'ENOENT'
      ? 'FS_NOT_FOUND'
      : errno === 'EACCES' || errno === 'EPERM'
        ? 'FS_PERMISSION_DENIED'
        : errno === 'ENOTDIR'
          ? 'FS_NOT_DIRECTORY'
          : errno === 'EISDIR'
            ? 'FS_NOT_REGULAR_FILE'
            : fallbackCode
  return new FsioError(
    error instanceof Error ? error.message : String(error),
    code,
    error instanceof Error ? error : undefined,
  )
}

/**
 * Derive the opaque version token for one metadata reading.
 *
 * The harness treats this token as opaque but requires it to change whenever the
 * file changes. Device, inode, size and both nanosecond timestamps together make a
 * rewrite that preserves size and mtime still detectable through `ctime`, which is
 * the strongest freshness signal a POSIX inode offers.
 *
 * @param {import('node:fs').Stats} info
 * @returns {string}
 */
export function versionOf(info) {
  return [
    info.dev,
    info.ino,
    info.size,
    Math.trunc(info.mtimeMs * 1e6),
    Math.trunc(info.ctimeMs * 1e6),
  ].join(':')
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
 * Resolve a path against an optional base without requiring it to exist.
 *
 * @param {string} target path, absolute or relative
 * @param {string} [cwd] base for a relative path
 * @returns {string} absolute normalized path
 */
export function toAbsolute(target, cwd) {
  if (target.length === 0) throw new FsioError('path must not be empty', 'FS_IO_ERROR')
  if (isAbsolute(target)) return normalize(target)
  return resolvePath(cwd ?? process.cwd(), target)
}

/**
 * Resolve a path to its canonical identity, following every symlink.
 *
 * A path that does not exist cannot be realpath'd, so its parent is canonicalized
 * and the final component appended. That keeps identity stable for a file that is
 * about to be created, which guarded creation depends on.
 *
 * @param {string} absolute
 * @returns {Promise<{path: string, info: import('node:fs').Stats|undefined}>}
 */
export async function canonicalize(absolute) {
  try {
    const info = await stat(absolute)
    const canonical = await realpath(absolute)
    return { path: canonical, info }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw wrapFsError(error)
  }
  // Absent: canonicalize the deepest existing ancestor and re-append the tail, so
  // `resolve()` on a not-yet-created file still yields a stable identity.
  const segments = []
  let current = absolute
  for (;;) {
    try {
      const canonical = await realpath(current)
      const rebuilt = segments.length === 0 ? canonical : join(canonical, ...segments.reverse())
      return { path: rebuilt, info: undefined }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw wrapFsError(error)
    }
    const parent = dirname(current)
    if (parent === current) {
      // Reached the root without finding anything that exists.
      return { path: absolute, info: undefined }
    }
    segments.push(basename(current))
    current = parent
  }
}

/**
 * Probe a path: metadata for the resolved target, or absence.
 *
 * @param {string} absolute
 * @returns {Promise<{version: string, type: 'file'|'directory'|'other', size?: number}|undefined>}
 */
export async function probe(absolute) {
  try {
    const info = await stat(absolute)
    return {
      version: versionOf(info),
      type: kindOf(info),
      size: info.isFile() ? info.size : undefined,
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return undefined
    throw wrapFsError(error)
  }
}

/**
 * Probe a path WITHOUT following a final symlink.
 *
 * @param {string} absolute
 * @returns {Promise<{version: string, type: 'file'|'directory'|'symlink'|'other', size?: number}|undefined>}
 */
export async function probePath(absolute) {
  try {
    const info = await lstat(absolute)
    const type = info.isSymbolicLink() ? 'symlink' : kindOf(info)
    return {
      version: versionOf(info),
      type,
      size: info.isFile() ? info.size : undefined,
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return undefined
    throw wrapFsError(error)
  }
}

/**
 * Confirm a path names a regular file, with a code that says which check failed.
 *
 * @param {string} absolute
 * @param {string} [displayPath] path shown in the message
 * @returns {Promise<import('node:fs').Stats>}
 */
async function requireRegularFile(absolute, displayPath = absolute) {
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    throw wrapFsError(error, 'FS_NOT_FOUND')
  }
  if (info.isDirectory()) {
    throw new FsioError(`${displayPath} is a directory, not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  if (!info.isFile()) {
    throw new FsioError(`${displayPath} is not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return info
}

/**
 * Decide whether a buffer looks like text.
 *
 * Only the head is sampled, matching the local backend: a NUL byte in the first
 * {@link BINARY_SAMPLE_BYTES} marks the content binary. The asymmetry is deliberate
 * and documented — a late NUL would read as text.
 *
 * @param {Buffer} bytes
 * @returns {boolean}
 */
export function looksLikeText(bytes) {
  return !bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)
}

/**
 * Read one file as text, rejecting binary content and enforcing a cap.
 *
 * @param {string} absolute
 * @param {{maxBytes?: number, displayPath?: string}} [options]
 * @returns {Promise<string>}
 */
export async function readText(absolute, options = {}) {
  const displayPath = options.displayPath ?? absolute
  const info = await requireRegularFile(absolute, displayPath)
  if (options.maxBytes !== undefined && info.size > options.maxBytes) {
    throw new FsioError(
      `${displayPath} is ${info.size} bytes, over the ${options.maxBytes}-byte cap`,
      'FS_TOO_LARGE',
    )
  }
  let bytes
  try {
    bytes = await readFile(absolute)
  } catch (error) {
    throw wrapFsError(error)
  }
  if (!looksLikeText(bytes)) {
    throw new FsioError(`${displayPath} is not UTF-8 text`, 'FS_NOT_TEXT')
  }
  return bytes.toString('utf8')
}

/**
 * Read raw bytes with an inclusive cap.
 *
 * @param {string} absolute
 * @param {number|undefined} maxBytes
 * @param {{displayPath?: string}} [options]
 * @returns {Promise<Buffer>}
 */
export async function readBytes(absolute, maxBytes, options = {}) {
  const displayPath = options.displayPath ?? absolute
  const info = await requireRegularFile(absolute, displayPath)
  if (maxBytes !== undefined && info.size > maxBytes) {
    throw new FsioError(
      `${displayPath} is ${info.size} bytes, over the ${maxBytes}-byte cap`,
      'FS_TOO_LARGE',
    )
  }
  try {
    return await readFile(absolute)
  } catch (error) {
    throw wrapFsError(error)
  }
}

/**
 * Read one byte window without buffering the whole file beyond the window.
 *
 * @param {string} absolute
 * @param {number} offset 0-based first byte
 * @param {number} length largest byte count
 * @param {{displayPath?: string}} [options]
 * @returns {Promise<Buffer>}
 */
export async function readByteRange(absolute, offset, length, options = {}) {
  const displayPath = options.displayPath ?? absolute
  await requireRegularFile(absolute, displayPath)
  if (!Number.isInteger(offset) || offset < 0) {
    throw new FsioError(`offset must be a non-negative integer, got ${offset}`, 'FS_IO_ERROR')
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new FsioError(`length must be a non-negative integer, got ${length}`, 'FS_IO_ERROR')
  }
  let handle
  try {
    handle = await open(absolute, 'r')
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } catch (error) {
    throw wrapFsError(error)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * List one directory level in stable name order.
 *
 * Entries carry resolved targets and cheap metadata only; contents are never read.
 *
 * @param {string} absolute
 * @param {(child: string) => string} [keyOf] maps an absolute child path to its target key
 * @returns {Promise<Array<{name: string, type: 'file'|'directory'|'other', path: string, version: string, size?: number}>>}
 */
export async function listDir(absolute, keyOf) {
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    throw wrapFsError(error, 'FS_NOT_FOUND')
  }
  if (!info.isDirectory()) {
    throw new FsioError(`${absolute} is not a directory`, 'FS_NOT_DIRECTORY')
  }
  let names
  try {
    names = await readdir(absolute)
  } catch (error) {
    throw wrapFsError(error)
  }
  const entries = []
  for (const name of names) {
    const childPath = join(absolute, name)
    try {
      const childInfo = await lstat(childPath)
      // Directory listings follow physical traversal, so a symlink is reported as
      // the entry type its target resolves to, which is what consumers traverse.
      const resolved = childInfo.isSymbolicLink() ? await stat(childPath).catch(() => childInfo) : childInfo
      entries.push({
        name,
        type: kindOf(resolved),
        path: keyOf ? keyOf(childPath) : childPath,
        version: versionOf(childInfo),
        size: resolved.isFile() ? resolved.size : undefined,
      })
    } catch {
      // A racing deletion removes the entry rather than failing the whole listing.
      continue
    }
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return entries
}

/* -------------------------------------------------------------------------- */
/* atomic publication                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Publish bytes atomically and durably.
 *
 * Staging into a sibling temporary file, fsyncing it, then renaming keeps readers
 * on either the old or the new content. The target's mode is carried across the
 * replacement because a rename would otherwise install the temporary file's mode.
 *
 * @param {string} absolute destination
 * @param {Buffer|string} content
 * @param {{noReplace?: boolean}} [options] `noReplace` refuses to overwrite
 * @returns {Promise<{operation: 'create'|'update'}>}
 */
async function publish(absolute, content, options = {}) {
  let existing
  try {
    existing = await stat(absolute)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw wrapFsError(error)
  }
  const operation = existing ? 'update' : 'create'
  if (options.noReplace && existing) {
    throw new FsioError(`${absolute} already exists`, 'FS_NOT_OBSERVED')
  }
  if (existing?.isDirectory()) {
    throw new FsioError(`${absolute} is a directory`, 'FS_NOT_REGULAR_FILE')
  }

  const directory = dirname(absolute)
  const stagingDir = join(directory, '.dsh-wsl-stage')
  try {
    await mkdir(stagingDir, { mode: 0o700, recursive: true })
  } catch (error) {
    throw wrapFsError(error)
  }
  const staging = join(stagingDir, randomUUID())

  let handle
  try {
    handle = await open(staging, 'wx', existing ? existing.mode : 0o644)
    await handle.writeFile(content)
    // fsync so a crash after rename cannot leave a zero-length published file.
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(staging, absolute)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(staging, { force: true }).catch(() => {})
    throw wrapFsError(error)
  } finally {
    // Best effort: a leftover private staging directory is residue, not corruption.
    await rm(stagingDir, { force: true, recursive: true }).catch(() => {})
  }
  return { operation }
}

/**
 * Serialize mutations per canonical path.
 *
 * A read→guard→write window must not interleave, or two concurrent guarded writes
 * could both observe the old version and both succeed. The harness requires exactly
 * one winner and the rest to see the new version and reject as stale.
 */
class MutationLocks {
  /** @type {Map<string, Promise<unknown>>} */
  #tails = new Map()

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async run(key, operation) {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(
      () => undefined,
      () => undefined,
    )
    this.#tails.set(key, tail)
    try {
      return await current
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}

const LOCKS = new MutationLocks()

/* -------------------------------------------------------------------------- */
/* text normalization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Detect the dominant line-ending style of storage text.
 *
 * @param {string} text
 * @returns {'crlf'|'lf'}
 */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? 'crlf' : 'lf'
}

/**
 * Normalize storage text to LF so matching is style-insensitive.
 *
 * @param {string} text
 * @returns {string}
 */
export function toLf(text) {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Restore a line-ending style after editing.
 *
 * @param {string} text LF-normalized text
 * @param {'crlf'|'lf'} eol
 * @returns {string}
 */
export function applyEol(text, eol) {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

/* -------------------------------------------------------------------------- */
/* mutations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compute the diff basis for an overwrite.
 *
 * The harness takes LF-normalized storage text, or `null` when either side exceeds
 * the caller's bound or the prior content was not text.
 *
 * @param {string|undefined} priorPath path to read, or undefined for a create
 * @param {string} after LF-normalized new content
 * @param {number} maxBytes per-side bound
 * @returns {Promise<string|null>}
 */
async function diffBasis(priorPath, after, maxBytes) {
  if (priorPath === undefined) return null
  if (Buffer.byteLength(after, 'utf8') > maxBytes) return null
  const bytes = await readBytes(priorPath, maxBytes).catch(() => undefined)
  if (bytes === undefined) return null
  if (!looksLikeText(bytes)) return null
  return toLf(bytes.toString('utf8'))
}

/**
 * Create or replace a file atomically, with an optional guard.
 *
 * @param {object} options
 * @param {string} options.absolute canonical destination
 * @param {string} options.displayPath path shown in messages
 * @param {string} options.content new text, written as given
 * @param {{kind: 'createIfAbsent'}|{kind: 'replaceIfVersion', version: string}} [options.expected]
 * @param {number} [options.diffBasisMaxBytes]
 * @returns {Promise<{operation: 'create'|'update', version: string, before: string|null, after: string}>}
 */
export async function writeText(options) {
  const { absolute, displayPath, content, expected, diffBasisMaxBytes = 10 * 1024 * 1024 } = options
  return LOCKS.run(absolute, async () => {
    const current = await probe(absolute)

    if (expected?.kind === 'createIfAbsent' && current !== undefined) {
      throw new FsioError(`${displayPath} already exists`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (current === undefined) {
        throw new FsioError(`${displayPath} does not exist`, 'FS_STALE_VERSION')
      }
      if (current.version !== expected.version) {
        throw new FsioError(
          `${displayPath} changed since it was observed`,
          'FS_STALE_VERSION',
        )
      }
    }

    const after = toLf(content)
    const before = await diffBasis(current === undefined ? undefined : absolute, after, diffBasisMaxBytes)
    // Preserve the file's dominant line-ending style so an edit round-trip does not
    // rewrite every line of a CRLF file.
    const eol = before === null ? 'lf' : detectEol(before)
    const { operation } = await publish(absolute, applyEol(after, eol), {
      noReplace: expected?.kind === 'createIfAbsent',
    })
    const next = await probe(absolute)
    if (next === undefined) {
      throw new FsioError(`${displayPath} vanished immediately after the write`, 'FS_IO_ERROR')
    }
    return { operation, version: next.version, before, after }
  })
}

/**
 * Apply a literal replacement atomically, with an optional version guard.
 *
 * The guard is checked BEFORE matching, so a stale edit reports `FS_STALE_VERSION`
 * rather than a misleading no-match. Matching is performed on LF-normalized text and
 * the file's dominant line ending is restored on publication.
 *
 * @param {object} options
 * @param {string} options.absolute canonical path
 * @param {string} options.displayPath path shown in messages
 * @param {{oldString: string, newString: string, replaceAll: boolean}} options.edit
 * @param {{version: string}} [options.expected]
 * @returns {Promise<{version: string, before: string, after: string}>}
 */
export async function editText(options) {
  const { absolute, displayPath, edit, expected } = options
  if (typeof edit?.oldString !== 'string' || edit.oldString.length === 0) {
    throw new FsioError('oldString must be a non-empty string', 'FS_IO_ERROR')
  }

  return LOCKS.run(absolute, async () => {
    const current = await probe(absolute)
    if (current === undefined) {
      // The harness reports a missing target as stale whether or not a guard was
      // supplied, so a caller sees one code for "cannot edit this".
      throw new FsioError(`${displayPath} does not exist`, 'FS_STALE_VERSION')
    }
    if (expected && current.version !== expected.version) {
      throw new FsioError(`${displayPath} changed since it was observed`, 'FS_STALE_VERSION')
    }

    const raw = await readText(absolute, { displayPath })
    const eol = detectEol(raw)
    const before = toLf(raw)
    const needle = toLf(edit.oldString)
    const replacement = toLf(edit.newString)

    // Overlapping occurrences would make `replaceAll` ambiguous, so they are rejected
    // rather than silently collapsing.
    const occurrences = countOccurrences(before, needle)
    if (occurrences === 0) {
      throw new FsioError(
        `oldString was not found in ${displayPath}`,
        'FS_EDIT_NOT_FOUND',
      )
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new FsioError(
        `oldString matches ${occurrences} times in ${displayPath}; pass replaceAll or add context`,
        'FS_AMBIGUOUS_EDIT',
      )
    }

    const after = edit.replaceAll
      ? before.split(needle).join(replacement)
      : before.replace(needle, () => replacement)

    await publish(absolute, applyEol(after, eol))
    const next = await probe(absolute)
    if (next === undefined) {
      throw new FsioError(`${displayPath} vanished immediately after the edit`, 'FS_IO_ERROR')
    }
    return { version: next.version, before, after }
  })
}

/**
 * Count non-overlapping occurrences of a literal needle.
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/* -------------------------------------------------------------------------- */
/* walking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Recursively collect regular files under a root, bounded by count and depth.
 *
 * Used by the consumer's file search; kept here so the walk happens beside the data
 * rather than streaming the whole tree across the wire.
 *
 * @param {string} root absolute directory
 * @param {{maxEntries?: number, maxDepth?: number, includeHidden?: boolean}} [options]
 * @returns {Promise<Array<{path: string, size: number}>>}
 */
export async function walkFiles(root, options = {}) {
  const maxEntries = options.maxEntries ?? 20_000
  const maxDepth = options.maxDepth ?? 16
  const includeHidden = options.includeHidden ?? false
  /** @type {Array<{path: string, size: number}>} */
  const found = []

  /** @param {string} directory @param {number} depth */
  const visit = async (directory, depth) => {
    if (found.length >= maxEntries || depth > maxDepth) return
    let names
    try {
      names = await readdir(directory)
    } catch {
      return
    }
    for (const name of names) {
      if (found.length >= maxEntries) return
      if (!includeHidden && name.startsWith('.')) continue
      const child = join(directory, name)
      let info
      try {
        info = await lstat(child)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await visit(child, depth + 1)
      } else if (info.isFile()) {
        found.push({ path: child, size: info.size })
      }
    }
  }

  await visit(root, 0)
  found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return found
}

/** Separator re-export so the helper's path handling stays explicit. */
export const PATH_SEPARATOR = sep
