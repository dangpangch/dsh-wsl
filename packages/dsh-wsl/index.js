/**
 * dsh-wsl: run the whole DeepSeek Harness against a WSL2 distribution.
 *
 * Scope of the switch
 * -------------------
 * This is a WHOLE-PROFILE mode, not per-workspace routing. `fs` and `subprocess` are
 * host-plane services: a consumer reaches them by `inject`, which resolves during fiber
 * construction before any Session exists, so they are one per composition rather than one
 * per workspace. The reference SSH provider draws the same line. Consequently the local
 * providers are disabled by this bundle's patch and every Session in the profile works
 * inside the distribution. Local and WSL Sessions cannot coexist in one profile.
 *
 * The host still runs the Harness, the model transport and Session storage; the
 * distribution supplies files and processes. The distribution therefore needs no second
 * Harness installation, `$DSH_HOME`, or session log.
 *
 * @module @local/dsh-wsl
 */
import {
  createWslRuntime,
  listDistributions,
  paths,
  provideHostServices,
  resolveCacheDir,
} from './lib/provider.js'

/** Service names this plugin takes over at the host plane. */
export const PROVIDED_SERVICES = Object.freeze(['fs', 'subprocess', 'sandbox'])

/** Where the deployable helper pair lives inside this package. */
export { HELPER_SOURCE_DIR } from './lib/provider.js'

/**
 * Configuration for the dsh-wsl bundle row.
 *
 * @typedef {object} Config
 * @property {string} [distro] distribution name; empty selects the system default
 * @property {string} [user] Linux user to run as; empty uses the distribution default
 * @property {string} [cwd] workspace root used as the filesystem's relative base
 * @property {string} [homeDir] override the resolved Linux home
 * @property {string} [cacheDir] window-side runtime archive cache
 * @property {'push'|'distro'|'existing'} [runtimeStrategy] how to obtain the in-distribution Node
 * @property {string} [helperSourceDir] override the helper pair location
 * @property {number} [requestTimeoutMs] administrative request deadline
 * @property {boolean} [autoConnect] connect during activation instead of on first use
 */

/**
 * Cordis plugin entry point.
 *
 * Returns its connection surface rather than publishing it as a global service: consumers
 * reach WSL through the `fs` and `subprocess` seams, so a process-wide `wsl` service would
 * only add a name to the harness's service namespace that nothing else expects.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} [config]
 * @returns {object} the connection surface for this plugin instance
 */
export function apply(ctx, config = {}) {
  const distro = config.distro ?? ''

  const runtime = createWslRuntime({
    distro,
    user: config.user || undefined,
    cwd: config.cwd,
    homeDir: config.homeDir,
    cacheDir: config.cacheDir ?? resolveCacheDir(),
    runtimeStrategy: config.runtimeStrategy,
    helperSourceDir: config.helperSourceDir,
    requestTimeoutMs: config.requestTimeoutMs,
  })

  // Registered synchronously so every `inject(['fs'])` / `inject(['subprocess'])` /
  // `inject(['sandbox'])` consumer resolves this composition's providers. The
  // connection itself is opened lazily.
  const { fs, subprocess, sandbox, disposers } = provideHostServices(ctx, runtime, { distro })

  const api = {
    /** Distribution inventory, for the settings page and the workspace picker. */
    listDistributions,
    /** Connect the configured target; idempotent. */
    connect: () => runtime.start(),
    /** Current connection state, without connecting anything. */
    status: () => runtime.status(),
    /** Path translation helpers, so the UI never reimplements them. */
    paths,
    /** The live providers, for diagnostics and tests. */
    providers: { fs, subprocess, sandbox },
  }

  // Disposal is owned by the context: unloading the plugin must release the service slots
  // it took over AND leave no `wsl.exe` child, helper, or in-distribution process behind.
  ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* an already-released slot is not worth failing teardown over */
        }
      }
      return runtime.dispose()
    },
    'dsh-wsl.lifecycle',
  )

  if (config.autoConnect) {
    // Activation must not fail on an unreachable distribution; the error is surfaced
    // through `status()` and again on the first real operation.
    void runtime.start().catch(() => {})
  }

  return api
}

export default apply
