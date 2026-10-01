/**
 * Windows ↔ WSL path translation.
 *
 * Two path spaces meet here. The harness host speaks Windows paths; the execution
 * world inside the distribution speaks Linux paths. Getting this wrong is uniquely
 * dangerous for this plugin — a mistranslation silently targets a *different* file
 * rather than failing — so every conversion is pure, total, and explicitly reports
 * that it cannot translate instead of guessing.
 *
 * The mapping is the one WSL itself establishes:
 *   `C:\Users\me\proj`      ↔ `/mnt/c/Users/me/proj`
 *   `\\wsl$\debian\home\me` ↔ `/home/me`      (also `\\wsl.localhost\…`)
 *
 * @module @local/dsh-wsl/paths
 */

/** Mount point under which WSL exposes Windows drives. */
export const DRIVE_MOUNT_ROOT = '/mnt'

/**
 * Normalize a Windows path to forward slashes without touching its meaning.
 *
 * @param {string} windowsPath
 * @returns {string}
 */
function toForwardSlashes(windowsPath) {
  return windowsPath.replace(/\\/g, '/')
}

/**
 * Convert an absolute Windows path to its Linux equivalent inside WSL.
 *
 * Returns `undefined` rather than a best guess when the path has no mapping:
 * a wrong answer here would silently operate on a different file.
 *
 * @param {string} windowsPath absolute Windows path, drive-letter or UNC form
 * @returns {string|undefined} absolute Linux path, or undefined when unmappable
 */
export function windowsToLinux(windowsPath) {
  if (typeof windowsPath !== 'string' || windowsPath.length === 0) return undefined

  // UNC: \\wsl$\<distro>\... and \\wsl.localhost\<distro>\... are already Linux paths.
  const unc = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(windowsPath)
  if (unc) {
    const rest = (unc[3] ?? '').replace(/[\\/]+$/, '')
    return rest.length === 0 ? '/' : `/${toForwardSlashes(rest)}`
  }

  // Host-side `path.resolve()` re-roots an absolute Linux path onto the process drive:
  // `/mnt/d/ws` arrives here as `D:\mnt\d\ws`. Skill discovery does exactly this
  // (dsh-skill-filesystem resolves the lookup cwd on the host before walking `.git`
  // through the fs service), so without this undo every project skill silently
  // disappears under a Linux-path session cwd.
  // ponytail: a genuinely real Windows directory named `<drive>:\mnt\...` would be
  // mistranslated by this undo; if that ever matters, gate it on a known-Linux-origin cwd.
  // `mnt` stays case-sensitive: the mangle preserves the lowercase Linux mount point.
  const mangled = /^([A-Za-z]):[\\/](mnt(?:[\\/].*)?)$/.exec(windowsPath)
  if (mangled) {
    return `/${toForwardSlashes(mangled[2].replace(/[\\/]+$/, ''))}`
  }

  // A drive-qualified path: C:\dir or C:/dir
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(windowsPath)
  if (drive) {
    const letter = drive[1].toLowerCase()
    const rest = (drive[2] ?? '').replace(/[\\/]+$/, '')
    return rest.length === 0 ? `${DRIVE_MOUNT_ROOT}/${letter}` : `${DRIVE_MOUNT_ROOT}/${letter}/${toForwardSlashes(rest)}`
  }

  // A drive-relative path such as C:dir depends on that drive's current directory,
  // which is a per-process Windows notion with no WSL equivalent.
  if (/^[A-Za-z]:/.test(windowsPath)) return undefined

  // Already Linux-style and absolute.
  if (windowsPath.startsWith('/')) return toForwardSlashes(windowsPath)

  return undefined
}

/**
 * Convert an absolute Linux path inside WSL to a Windows path.
 *
 * `/mnt/<drive>/…` yields a drive path so Windows-side tools open the real location.
 * Any other Linux path yields a `\\wsl$\<distro>\…` UNC path, which Windows can read
 * while the file remains WSL-local storage — that distinction matters, because a
 * `/mnt` path and a `\\wsl$` path have different performance and permission behavior.
 *
 * @param {string} linuxPath absolute Linux path
 * @param {string} distro distribution name used to build the UNC share
 * @returns {string|undefined} Windows path, or undefined when unmappable
 */
export function linuxToWindows(linuxPath, distro) {
  if (typeof linuxPath !== 'string' || !linuxPath.startsWith('/')) return undefined

  const drive = new RegExp(`^${DRIVE_MOUNT_ROOT}/([a-z])(?:/(.*))?$`, 'i').exec(linuxPath)
  if (drive) {
    const letter = drive[1].toUpperCase()
    const rest = (drive[2] ?? '').replace(/\/+$/, '')
    return rest.length === 0
      ? `${letter}:\\`
      : `${letter}:\\${rest.split('/').join('\\')}`
  }

  const rest = linuxPath.replace(/^\/+/, '')
  const share = distro && distro.length > 0 ? distro : 'localhost'
  return rest.length === 0 ? `\\\\wsl$\\${share}` : `\\\\wsl$\\${share}\\${rest.split('/').join('\\')}`
}

/**
 * Test whether a Linux path lives on a Windows drive mounted through drvfs.
 *
 * This is the case that must be warned about: the drvfs mount does not provide
 * reliable POSIX `ctime`/`inode` semantics, so the harness's version guard is
 * weaker there than on native Linux storage.
 *
 * @param {string} linuxPath absolute Linux path
 * @returns {boolean}
 */
export function isWindowsBackedPath(linuxPath) {
  return typeof linuxPath === 'string' && new RegExp(`^${DRIVE_MOUNT_ROOT}/[a-z](?:/|$)`, 'i').test(linuxPath)
}

/**
 * Expand a leading `~` against a known home directory.
 *
 * A bare `~user` form is not expanded: resolving another user's home requires the
 * distribution's account database, so the helper does it instead of guessing here.
 *
 * @param {string} path
 * @param {string} home
 * @returns {{path: string, expanded: boolean}}
 */
export function expandHome(path, home) {
  if (path === '~') return { path: home, expanded: true }
  if (path.startsWith('~/')) return { path: `${home.replace(/\/+$/, '')}/${path.slice(2)}`, expanded: true }
  return { path, expanded: false }
}

/**
 * Join a workspace root and a relative path without normalizing away its meaning.
 *
 * Segment-by-segment normalization resolves `.` and `..` lexically. A fully correct
 * answer would follow symlinks, which the filesystem provider does when it resolves
 * the result, so lexical handling is sufficient and cheaper here.
 *
 * @param {string} root absolute Linux root
 * @param {string} relative relative path
 * @returns {string} absolute Linux path
 */
export function joinLinux(root, relative) {
  if (relative.startsWith('/')) return relative
  const segments = `${root}/${relative}`.split('/')
  const out = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return `/${out.join('/')}`
}
