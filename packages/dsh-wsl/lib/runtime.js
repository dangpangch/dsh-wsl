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
