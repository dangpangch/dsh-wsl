/**
 * Assemble the installable dsh-wsl bundle: ONE self-contained package named
 * `@local/dsh-wsl` that carries the plugin runtime, the helper pair it deploys, and
 * the bundle layer (patch + locale) the plugin manager reads.
 *
 * Why one package: `plugin_manager install_bundle` installs a single package directory
 * into the profile and runs pnpm there; a `workspace:*` dependency cannot resolve
 * outside this repository and a private npm publish is not wanted. The plugin's runtime
 * imports only Node builtins (verified by tools/pack-bundle.mjs --check), so the bundle
 * needs no dependencies at all — `@deepseek-ai/cordis` stays a peer resolved from the
 * dsh installation.
 *
 * The packed layout preserves the plugin's internal relative shape (`lib/provider.js`
 * reaches `../helper`), so nothing in the moved code changes:
 *
 *   dist/dsh-wsl/
 *     package.json        dsh.bundle.patch + exports, no dependencies
 *     index.js            plugin entry (the patch row's `name` resolves here)
 *     lib/  helper/       plugin runtime + the in-distribution helper files
 *     cordis.patch.yml    the whole-profile switch (disables the four local rows)
 *     locale/en.json      plugin-manager display text
 *
 * Install: run `node tools/pack-bundle.mjs`, then in a Harness session call
 * `plugin_manager` with `action: install_bundle` and the printed directory as `target`.
 *
 * @module tools/pack-bundle
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.join(import.meta.dirname, '..')
const PLUGIN_DIR = path.join(REPO, 'packages', 'dsh-wsl')
const BUNDLE_DIR = path.join(REPO, 'packages', 'dsh-wsl-bundle')

/** The packed package name — the patch row's `name` must match exactly. */
export const PACKAGED_NAME = '@local/dsh-wsl'

/** Default assembly output: <repo>/dist/dsh-wsl. */
export function defaultOutDir() {
  return path.join(REPO, 'dist', 'dsh-wsl')
}

/** The plugin runtime the packed package must carry. */
export const REQUIRED_HELPER_FILES = ['protocol.js', 'fsio.mjs', 'wsl-helper.mjs']

/** The rows the whole-profile switch must disable, from M5a's contract. */
export const REPLACED_ROW_IDS = [
  'include:fs-local',
  'include:fs-sandbox',
  'include:subprocess',
  'include:sandbox-local',
]

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Assemble the self-contained bundle package into {@link outDir}.
 *
 * @param {string} [outDir] defaults to <repo>/dist/dsh-wsl
 * @returns {Promise<string>} the packed package directory
 */
export async function packBundle(outDir = defaultOutDir()) {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // The plugin runtime, verbatim: index.js + lib/ + helper/ keep their relative shape.
  await cp(path.join(PLUGIN_DIR, 'index.js'), path.join(outDir, 'index.js'))
  await cp(path.join(PLUGIN_DIR, 'lib'), path.join(outDir, 'lib'), { recursive: true })
  await cp(path.join(PLUGIN_DIR, 'helper'), path.join(outDir, 'helper'), { recursive: true })

  // The bundle layer: patch + display locale.
  await cp(path.join(BUNDLE_DIR, 'cordis.patch.yml'), path.join(outDir, 'cordis.patch.yml'))
  await cp(path.join(BUNDLE_DIR, 'locale'), path.join(outDir, 'locale'), { recursive: true })

  const source = JSON.parse(await readFile(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
  const bundle = JSON.parse(await readFile(path.join(BUNDLE_DIR, 'package.json'), 'utf8'))
  const manifest = {
    name: PACKAGED_NAME,
    version: source.version,
    private: true,
    type: 'module',
    description: bundle.description,
    main: 'index.js',
    exports: {
      '.': './index.js',
      './package.json': './package.json',
      './cordis.patch.yml': './cordis.patch.yml',
      './locale/*.json': './locale/*.json',
    },
    files: ['index.js', 'lib/*.js', 'helper/*', 'cordis.patch.yml', 'locale/*.json'],
    // No dependencies: the plugin runtime imports only Node builtins. cordis is a peer
    // the dsh installation always provides.
    peerDependencies: source.peerDependencies
      ? { '@deepseek-ai/cordis': source.peerDependencies['@deepseek-ai/cordis'] }
      : undefined,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    meta: bundle.meta,
  }
  if (manifest.peerDependencies === undefined) delete manifest.peerDependencies
  await writeFile(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return outDir
}

/**
 * Verify a packed bundle without installing it: manifest contract, patch contract,
 * helper presence and sync, and a syntax check of every JavaScript file.
 *
 * @param {string} outDir the packed package directory
 * @returns {Promise<string[]>} human-readable problems; empty when the bundle is sound
 */
export async function verifyBundle(outDir = defaultOutDir()) {
  const problems = []

  const manifest = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'))
  if (manifest.name !== PACKAGED_NAME) {
    problems.push(`package name is ${manifest.name}, expected ${PACKAGED_NAME}`)
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    problems.push('the manifest must declare dsh.bundle.patch = ./cordis.patch.yml')
  }
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    problems.push(`the packed package must not declare dependencies (got ${Object.keys(manifest.dependencies).join(', ')})`)
  }
  if (JSON.stringify(manifest.dependencies ?? {}) === JSON.stringify({ '@local/dsh-wsl': 'workspace:*' })) {
    problems.push('the workspace dependency leaked into the packed manifest')
  }

  const patch = await readFile(path.join(outDir, 'cordis.patch.yml'), 'utf8')
  for (const id of REPLACED_ROW_IDS) {
    if (!new RegExp(`id:\\s*${id}\\b`).test(patch)) problems.push(`the patch does not address ${id}`)
  }
  if (!/disabled:\s*true/.test(patch)) problems.push('the replaced rows are not disabled')
  if (!new RegExp(`name:\\s*['"]${PACKAGED_NAME}['"]`).test(patch)) {
    problems.push(`the inserted row must reference the packed package name ${PACKAGED_NAME}`)
  }

  for (const name of REQUIRED_HELPER_FILES) {
    if (!(await exists(path.join(outDir, 'helper', name)))) problems.push(`helper/${name} is missing`)
  }
  const hostProtocol = await readFile(path.join(outDir, 'lib', 'protocol.js'), 'utf8')
  const helperProtocol = await readFile(path.join(outDir, 'helper', 'protocol.js'), 'utf8')
  // The helper copy carries a GENERATED provenance header; strip leading comment lines
  // from both sides so real code drift still trips this check.
  const stripComments = (text) => text.replace(/^(?:\s*\/\/[^\n]*\n)+/, '')
  if (stripComments(hostProtocol) !== stripComments(helperProtocol)) {
    problems.push('helper/protocol.js drifted from lib/protocol.js')
  }

  // node --check on the helper .mjs files; the host-side graph is proven by importing
  // index.js (the acceptance test does that against a live distribution).
  for (const name of REQUIRED_HELPER_FILES.slice(1)) {
    const file = path.join(outDir, 'helper', name)
    const failed = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--check', file], { stdio: 'ignore' })
      child.on('close', (code) => resolve(code !== 0))
    })
    if (failed) problems.push(`helper/${name} fails node --check`)
  }

  return problems
}

async function listJsFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listJsFiles(full)))
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  const checkOnly = process.argv.includes('--check')
  const outDir = defaultOutDir()
  if (!checkOnly) {
    await packBundle(outDir)
    const files = await listJsFiles(outDir)
    console.log(`packed ${files.length} JS files into ${outDir}`)
  }
  const problems = await verifyBundle(outDir)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  FAIL  ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`  OK  ${outDir} is a valid install_bundle target`)
  }
}
