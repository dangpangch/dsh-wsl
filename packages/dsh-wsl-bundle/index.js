/**
 * Bundle host half.
 *
 * The bundle exists to carry a patch layer, so there is nothing to apply here: the WSL
 * providers are registered by the `@local/dsh-wsl` row the patch inserts, and the Client
 * half renders the settings surface. Keeping this file empty of behavior is deliberate —
 * a bundle that also registered providers would give the switch two owners.
 *
 * @module dsh-wsl-bundle
 */
export function apply() {}
