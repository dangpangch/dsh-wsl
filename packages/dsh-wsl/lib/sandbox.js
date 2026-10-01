/**
 * WSL sandbox provider: file-effect confinement for processes inside the distribution.
 *
 * The seam is argv-wrapping, not execution: {@link WslSandbox.confine} returns the
 * argv the caller spawns in place of its own — typically through this plugin's
 * `ctx.subprocess`. The helper in the distribution applies the bwrap profile there,
 * so the confinement governs the same kernel the wrapped process actually runs on.
 * The profile and its evidence (enforcement level, denial signatures, runner-failure
 * rules) are the same dialect `dsh-sandbox-local` speaks on Linux, so consumers
 * cannot tell the two backends apart by behavior.
 *
 * Fail-closed rule, inherited from the seam: `confine` either returns enforcing
 * argv or rejects with `SANDBOX_UNAVAILABLE`. Silent unconfined passthrough is
 * forbidden, and `danger-full-access` never reaches this provider — consumers
 * bypass `confine()` for it by contract.
 *
 * @module @local/dsh-wsl/sandbox
 */

/**
 * The one sandbox failure this provider raises: the requested confined mode cannot
 * be enforced in this distribution. Carries the seam's stable code so callers
 * branch on it, never on message text.
 */
export class WslSandboxUnavailableError extends Error {
  /**
   * @param {string} message human-readable detail; never parsed by callers
   * @param {Error|undefined} [cause] the transport-level failure, when there was one
   */
  constructor(message, cause) {
    super(message)
    this.name = 'WslSandboxUnavailableError'
    this.code = 'SANDBOX_UNAVAILABLE'
    if (cause) this.cause = cause
  }
}

/**
 * Rebuild a helper-side refusal as {@link WslSandboxUnavailableError}.
 *
 * `SANDBOX_UNAVAILABLE` is outside the transport's code vocabulary, so it arrives
 * out of band as `appCode`, exactly like the `FS_*` codes.
 *
 * @param {unknown} error
 * @returns {WslSandboxUnavailableError|Error}
 */
function asSandboxError(error) {
  const held = /** @type {{code?: unknown, appCode?: unknown, message?: unknown}} */ (error)
  for (const candidate of [held?.appCode, held?.code]) {
    if (candidate === 'SANDBOX_UNAVAILABLE') {
      return new WslSandboxUnavailableError(
        typeof held?.message === 'string' ? held.message : 'sandbox is unavailable in the distribution',
        error instanceof Error ? error : undefined,
      )
    }
  }
  return /** @type {Error} */ (error)
}

/**
 * Confine-one-argv provider over the WSL connection.
 *
 * Plain object rather than a `Service` subclass, matching the other providers in
 * this package: registration is `ctx.provide('sandbox', …)` at the host plane.
 */
export class WslSandbox {
  /** Lazy connection opener shared with the runtime. @type {() => Promise<object>} */
  #connect

  /**
   * @param {object} options
   * @param {() => Promise<{request: Function}>} options.connect resolves the live connection
   */
  constructor(options) {
    this.#connect = options.connect
  }

  /**
   * Wrap `argv` so it executes confined under `policy` inside the distribution.
   *
   * @param {readonly string[]} argv the exact argv the caller is about to spawn
   * @param {{mode: 'read-only'|'workspace-write', workspaceRoot: string}} policy
   *   the file-effect policy this execution runs under, carried per call
   * @param {AbortSignal} [signal] cancellation while the policy resolves
   * @returns {Promise<{argv: string[], enforcement: 'full'|'partial', denialSignatures: string[], runnerFailureRules: object[]}>}
   */
  async confine(argv, policy, signal) {
    signal?.throwIfAborted()
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new TypeError('sandbox: argv must be a non-empty array')
    }
    if (!policy || typeof policy !== 'object') {
      throw new TypeError('sandbox: policy is required')
    }
    if (policy.mode !== 'read-only' && policy.mode !== 'workspace-write') {
      throw new TypeError(
        `sandbox: mode must be "read-only" or "workspace-write" (got ${JSON.stringify(policy.mode)}); ` +
          'consumers bypass confine() for "danger-full-access"',
      )
    }
    if (typeof policy.workspaceRoot !== 'string' || !policy.workspaceRoot.startsWith('/')) {
      throw new TypeError('sandbox: workspaceRoot must be an absolute path in the distribution')
    }

    try {
      const connection = await this.#connect()
      return await connection.request(
        'sandbox.confine',
        { argv: [...argv], mode: policy.mode, workspaceRoot: policy.workspaceRoot },
        { signal },
      )
    } catch (error) {
      throw asSandboxError(error)
    }
  }
}
