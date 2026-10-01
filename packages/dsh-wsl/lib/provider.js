/**
 * Host-plane provider assembly for the whole-profile WSL mode.
 *
 * `fs` and `subprocess` are host-plane services: consumers reach them by `inject`, which
 * resolves during fiber construction, before any Session exists. They are therefore one
 * per composition, not one per workspace — so this plugin REPLACES the local providers
 * rather than routing around them, and the profile patch disables the rows it replaces.
 *
 * Nothing here connects eagerly. Both providers take a lazy `connect`, so availability is
 * synchronous (the seam requires that) while provisioning, helper deployment and the
 * `wsl.exe` handshake happen on first real use, which keeps a stopped distribution from
 * breaking activation.
 *
 * @module @local/dsh-wsl/provider
 */
import path from 'node:path'
import process from 'node:process'

import { WslFileSystem } from './fs.js'
import {
  DEPLOY_ROOT,
  RUNTIME,
  WIRE_VERSION,
  WslConnection,
  deployHelper,
  ensureBwrap,
  ensureRuntime,
  listDistributions,
  migrateLegacyDeployRoot,
  runWsl,
  withProvisionLock,
} from './connection.js'
import { WslSandbox } from './sandbox.js'
import { WslSubprocess } from './subprocess.js'
import { expandHome, isWindowsBackedPath, linuxToWindows, windowsToLinux } from './paths.js'

/** Where the deployable helper pair lives inside this package. */
export const HELPER_SOURCE_DIR = path.join(import.meta.dirname, '..', 'helper')

/** Service names this plugin registers at the host plane. */
export const PROVIDED_SERVICES = Object.freeze(['fs', 'subprocess', 'sandbox'])

/**
 * Resolve the cache directory used for the runtime archive.
 *
 * `$DSH_HOME` is the harness's own home, so the cache lands beside the rest of the
 * harness's state rather than inside whatever directory happened to be current.
 *
 * @param {string|undefined} configured
 * @returns {string}
 */
export function resolveCacheDir(configured) {
  if (configured) return configured
  const home = process.env.DSH_HOME
  return home
    ? path.join(home, 'cache', 'dsh-wsl')
    : path.join(process.cwd(), '.cache', 'dsh-wsl')
}

/**
 * Resolve the Linux home directory for a target user.
 *
 * Every deployment path derives from it, so it is resolved before provisioning rather
 * than assumed.
 *
 * @param {object} options
 * @param {string} [options.distro]
 * @param {string} [options.user]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} absolute Linux path
 */
export async function resolveHome(options) {
  const argv = []
  if (options.distro) argv.push('-d', options.distro)
  if (options.user) argv.push('-u', options.user)
  argv.push('--', 'bash', '-lc', 'printf %s "$HOME"')
  const result = await runWsl(argv, { signal: options.signal })
  const home = result.stdout.toString('utf8').trim()
  if (!home.startsWith('/')) {
    throw new Error(
      `dsh-wsl: could not resolve a Linux home for ${options.distro || 'the default distribution'} ` +
        `(got ${JSON.stringify(home)}); is the distribution running?`,
    )
  }
  return home
}

/**
 * Establish the one connection this composition works through.
 *
 * Idempotent: concurrent callers await a single setup, so two consumers cannot race two
 * helpers into the same distribution.
 *
 * @param {object} options
 * @param {string} [options.distro] distribution name; empty selects the system default
 * @param {string} [options.user] Linux user to run as
 * @param {string} options.cacheDir
 * @param {string} [options.helperSourceDir]
 * @param {'push'|'distro'|'existing'} [options.runtimeStrategy]
 * @param {string} [options.homeDir] override the resolved Linux home
 * @param {string} [options.cwd] workspace root used as the filesystem's relative base
 * @param {number} [options.requestTimeoutMs]
 * @param {(line: string) => void} [options.onLog]
 * @returns {{start: () => Promise<{connection: WslConnection, homeDir: string, cwd: string}>, status: () => object, dispose: () => Promise<void>}}
 */
export function createWslRuntime(options) {
  const cacheDir = options.cacheDir
  if (!cacheDir) throw new Error('dsh-wsl: cacheDir is required')
  const helperSourceDir = options.helperSourceDir ?? HELPER_SOURCE_DIR
  const runtimeStrategy = options.runtimeStrategy ?? 'push'
  const onLog = options.onLog ?? (() => {})

  /** @type {Promise<{connection: WslConnection, homeDir: string, cwd: string}>|undefined} */
  let setup
  /** @type {WslConnection|undefined} */
  let connection
  /** @type {Error|undefined} */
  let lastError
  let homeDir
  /** Resolved distribution name; empty until start() resolved the configured default. */
  let distroName = ''

  const start = () => {
    setup ??= (async () => {
      // An empty configured distro means "the system default". Resolve it to the real name
      // once, so every deployment path (node, helper, bwrap) lands in one canonical
      // `~/.dsh_wsl/<distro>/` directory shared with explicit connections.
      if (!options.distro) {
        const distributions = await listDistributions()
        const picked = distributions.find((d) => d.default) ?? distributions[0]
        if (!picked) {
          throw new Error('dsh-wsl: no WSL distribution is installed')
        }
        distroName = picked.name
        onLog(`no distro configured; using the system default "${distroName}"`)
      } else {
        distroName = options.distro
      }
      homeDir = options.homeDir ?? (await resolveHome({ distro: distroName, user: options.user }))

      // Provisioning writes into one shared deploy tree; two DSH windows (or a leftover
      // helper from a killed host) connecting to the same distro must not race it.
      const lockPath = `${homeDir}/${DEPLOY_ROOT}/.${distroName}.lock`
      const provisioned = await withProvisionLock(
        { distro: distroName, user: options.user, lockPath, onLog },
        async () => {
          await migrateLegacyDeployRoot({ distro: distroName, user: options.user, homeDir, onLog })
          const runtime = await ensureRuntime({
            distro: distroName,
            user: options.user,
            homeDir,
            strategy: runtimeStrategy,
            cacheDir,
            onLog,
          })
          const deployed = await deployHelper({
            distro: distroName,
            user: options.user,
            homeDir,
            sourceDir: helperSourceDir,
          })
          onLog(`helper deployed (${deployed.helperHash.slice(0, 12)}…)`)
          onLog('provisioning the sandbox backend')
          await ensureBwrap({ distro: distroName, user: options.user, homeDir, cacheDir, onLog })
          return { runtime, deployed }
        },
      )
      const runtime = provisioned.runtime
      const deployed = provisioned.deployed

      connection = new WslConnection({
        distro: distroName,
        user: options.user,
        helperPath: deployed.helperPath,
        nodePath: runtime.nodePath,
        requestTimeoutMs: options.requestTimeoutMs,
      })
      await connection.start()
      // Transport loss (helper crash, `wsl --shutdown`, distro restart) must invalidate
      // the cached setup, or every later start() hands back the dead connection forever.
      connection.onClose(() => {
        setup = undefined
        connection = undefined
      })
      onLog(
        `connected to ${options.distro || 'the default distribution'}: ` +
          `${connection.hello.platform}/${connection.hello.arch} node ${connection.hello.nodeVersion}`,
      )
      return { connection, homeDir, cwd: options.cwd ?? homeDir }
    })().catch((error) => {
      lastError = error instanceof Error ? error : new Error(String(error))
      // Drop the failed setup so a later attempt can retry instead of replaying it.
      setup = undefined
      connection = undefined
      throw lastError
    })
    return setup
  }

  return {
    start,
    /** The configured distribution, or the resolved system default once known. */
    get distro() {
      return distroName || options.distro || ''
    },
    status() {
      return {
        wireVersion: WIRE_VERSION,
        runtime: RUNTIME,
        configured: {
          distro: options.distro || null,
          user: options.user ?? null,
          runtimeStrategy,
        },
        connected: connection !== undefined && !connection.closed,
        helper: connection?.hello ?? null,
        homeDir: homeDir ?? null,
        lastError: lastError ? { message: lastError.message } : null,
      }
    },
    async dispose() {
      const current = connection
      connection = undefined
      setup = undefined
      await current?.dispose()
    },
  }
}

/**
 * Register the WSL providers at the host plane.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host context that owns the services
 * @param {ReturnType<typeof createWslRuntime>} runtime
 * @returns {{fs: object, subprocess: WslSubprocess, sandbox: WslSandbox, disposers: Array<() => unknown>}}
 */
export function provideHostServices(ctx, runtime) {
  const connect = async () => (await runtime.start()).connection

  // Both providers open the connection lazily, so registration is synchronous while the
  // actual provisioning stays on the first real operation. The filesystem's relative base is
  // resolved only when a relative path is first used, so registering performs no I/O.
  // The distro name reads through the runtime so host-path UNC mapping gets the resolved
  // default, not the empty configured value.
  const fs = new WslFileSystem({
    connect,
    distro: () => runtime.distro,
    defaultCwd: async () => (await runtime.start()).cwd,
  })
  const subprocess = new WslSubprocess({ connect })
  const sandbox = new WslSandbox({ connect })

  // `provide` is the registration here: these are plain objects, not `Service`
  // subclasses, so constructing them has no side effect. Registering on `ctx` (the host
  // plane) is what makes every `inject(['fs'])` consumer resolve them.
  const disposers = [
    ctx.provide('fs', fs),
    ctx.provide('subprocess', subprocess),
    ctx.provide('sandbox', sandbox),
  ]

  return { fs, subprocess, sandbox, disposers }
}

/** Path helpers, re-exported so the UI never reimplements them. */
export const paths = { windowsToLinux, linuxToWindows, expandHome, isWindowsBackedPath }

/** Distribution inventory for the settings UI and workspace picker. */
export { listDistributions }
