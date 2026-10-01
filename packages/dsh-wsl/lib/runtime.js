/**
 * Pinned Node runtime coordinates for the in-distribution helper.
 *
 * Verified against https://nodejs.org/dist/index.json before pinning; the checksum
 * is the published SHA-256 for that exact archive, so a tampered mirror is refused.
 *
 * @module @local/dsh-wsl/runtime
 */

/** Pinned Node release installed into the distribution. */
export const NODE_VERSION = 'v22.20.0'

/** The distribution architecture this pin serves. */
export const NODE_ARCH = 'linux-x64'

/** Archive filename as published on nodejs.org. */
export const NODE_ARCHIVE = `node-${NODE_VERSION}-${NODE_ARCH}.tar.xz`

/**
 * Published SHA-256 of {@link NODE_ARCHIVE}.
 *
 * Taken from https://nodejs.org/dist/v22.20.0/SHASUMS256.txt (the authoritative
 * release checksum list) and verified to match the `linux-x64.tar.xz` line. A
 * mismatch refuses installation rather than silently running an unverified runtime.
 */
export const NODE_SHA256 = '00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc'

/** Canonical download origin. */
export const NODE_DIST_BASE = 'https://nodejs.org/dist'

/**
 * Absolute URL of the pinned archive.
 *
 * @param {string} [base] override the origin, for a mirror or a local mock CDN
 * @returns {string} the archive URL
 */
export function nodeArchiveUrl(base = NODE_DIST_BASE) {
  return `${base.replace(/\/$/, '')}/${NODE_VERSION}/${NODE_ARCHIVE}`
}

/**
 * Pinned bubblewrap package for the in-distribution sandbox backend.
 *
 * The distro is Debian 13 (trixie); this is trixie's own `bubblewrap` build, taken
 * from deb.debian.org. The checksum was computed from the downloaded package at pin
 * time (the pool offers no published per-file checksum list); a mismatch refuses
 * deployment rather than running an unverified binary. Only `usr/bin/bwrap` is
 * extracted into the user's deploy directory — nothing is installed system-wide,
 * and the dependencies it needs (libc6, libcap2, libselinux1) are already in any
 * Debian 13 base system.
 */
export const BWRAP_DEB = Object.freeze({
  /** Debian pool archive filename. */
  archive: 'bubblewrap_0.12.0-1~deb13u1_amd64.deb',
  version: '0.12.0',
  sha256: '70aca4fa8daeacb677ec00e8063eb586f08ae3d94b1f11e684370b5524c43431',
  url: 'https://deb.debian.org/debian/pool/main/b/bubblewrap/bubblewrap_0.12.0-1~deb13u1_amd64.deb',
})

/** In-distribution path of the deployed bwrap binary, relative to the deploy root. */
export const BWRAP_BIN_PATH = 'bwrap/usr/bin/bwrap'
