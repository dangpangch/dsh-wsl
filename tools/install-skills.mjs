/**
 * Install the ponytail skill distribution into a DSH skill root.
 *
 * ponytail is an agent-portable skill distribution: the behavior lives in
 * `skills/<name>/SKILL.md` and every host adapter is meant to "point at the existing
 * `skills/` files" (its own `docs/agent-portability.md`). DSH's filesystem skill
 * provider discovers exactly that layout, so the portable set is what gets installed
 * rather than any host-specific adapter.
 *
 * Provenance is pinned, not assumed: the tree is fetched from one commit SHA and each
 * file's sha256 is verified against the GitHub blob SHA for that commit, so a moved
 * branch or a tampered mirror cannot silently change what lands on disk.
 *
 * Run:
 *   node tools/install-skills.mjs                     # install into the workspace
 *   node tools/install-skills.mjs --user              # install into $DSH_HOME/skills
 *   node tools/install-skills.mjs --both
 *   node tools/install-skills.mjs --check             # verify only, write nothing
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.join(HERE, '..')

/** Pinned upstream revision. `main` as resolved when this installer was written. */
const COMMIT = 'e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156'
const REPO = 'DietrichGebert/ponytail'
/** Raw origin for the pinned commit — a full SHA, so this URL is immutable. */
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`

/**
 * The portable skill set, from the distribution's `docs/agent-portability.md`.
 *
 * `gitSha` is the GitHub blob SHA for the file at {@link COMMIT}; GitHub blob SHAs are
 * the sha1 of `blob <len>\0<content>`, which is recomputed here rather than trusted.
 */
const SKILLS = [
  { name: 'ponytail', gitSha: '02c0712c86277d49d18a77da3a2b825657bf02d1' },
  { name: 'ponytail-review', gitSha: 'e137a855bd87119a4517895a1000a59b0999e1b8' },
  { name: 'ponytail-audit', gitSha: '5582d10335daff5b5947f9b77927fbc97f2047f3' },
  { name: 'ponytail-debt', gitSha: 'ecbc0ca8161b25ced3b4f728398c2ec33988a777' },
  { name: 'ponytail-gain', gitSha: '012e37b6bf31da1ed4bf936ec8aff53974d5291e' },
  { name: 'ponytail-help', gitSha: 'ba145c0ebb7c7e5682bb2f36047af3bf2030d470' },
]

/** Repository-level files carried along beside the skills. */
const EXTRAS = [
  { source: 'LICENSE', file: 'LICENSE', gitSha: '715d483338cea4365f0d91a27799cf61226d6bcf' },
]

const argv = new Set(process.argv.slice(2))
const checkOnly = argv.has('--check')
const toUser = argv.has('--user') || argv.has('--both')
const toWorkspace = !toUser || argv.has('--both')

/**
 * Compute the git blob SHA for content.
 *
 * @param {Buffer} content
 * @returns {string} 40-character lowercase hex
 */
function gitBlobSha(content) {
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex')
}

/**
 * Fetch one file at the pinned commit.
 *
 * @param {string} repoPath path inside the repository
 * @returns {Promise<Buffer>}
 */
async function fetchPinned(repoPath) {
  const response = await fetch(`${RAW}/${repoPath}`)
  if (!response.ok) {
    throw new Error(`fetch ${repoPath} failed with HTTP ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Verify content against its expected blob SHA.
 *
 * @param {string} label
 * @param {Buffer} content
 * @param {string} expected
 * @returns {string} the verified sha256, for the provenance record
 */
function verify(label, content, expected) {
  const actual = gitBlobSha(content)
  if (actual !== expected) {
    throw new Error(
      `${label}: content does not match the pinned revision\n` +
        `  expected blob ${expected}\n  received blob ${actual}\n` +
        '  the upstream branch moved or the download was tampered with; ' +
        'update the pin deliberately rather than accepting this',
    )
  }
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Install into one skill root.
 *
 * @param {string} root destination skill root
 * @param {Array<{name: string, content: Buffer, sha256: string}>} files
 * @param {Array<{file: string, content: Buffer, sha256: string}>} extras
 */
async function install(root, files, extras) {
  for (const file of files) {
    const destination = path.join(root, file.name, 'SKILL.md')
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, file.content)
  }
  // The distribution is MIT; the license travels with the copies.
  for (const extra of extras) {
    await writeFile(path.join(root, extra.file), extra.content)
  }
}

/**
 * Read a file, returning undefined when absent.
 *
 * @param {string} file
 * @returns {Promise<Buffer|undefined>}
 */
async function readIfPresent(file) {
  try {
    return await readFile(file)
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */

const files = []
for (const skill of SKILLS) {
  const repoPath = `skills/${skill.name}/SKILL.md`
  const content = await fetchPinned(repoPath)
  const sha256 = verify(repoPath, content, skill.gitSha)
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.toString('utf8'))
  const declaredName = /^name:\s*(\S+)/m.exec(frontmatter?.[1] ?? '')?.[1]
  if (declaredName !== skill.name) {
    // DSH keys skills by directory name and frontmatter name; a mismatch would make
    // the catalog disagree with the filesystem.
    throw new Error(`${repoPath}: frontmatter name ${declaredName} != directory ${skill.name}`)
  }
  files.push({ name: skill.name, content, sha256, gitSha: skill.gitSha })
  console.log(`verified  skills/${skill.name}/SKILL.md  (sha256 ${sha256.slice(0, 16)}…)`)
}

const extras = []
for (const extra of EXTRAS) {
  const content = await fetchPinned(extra.source)
  const sha256 = verify(extra.source, content, extra.gitSha)
  extras.push({ file: extra.file, content, sha256 })
  console.log(`verified  ${extra.source}`)
}

/** Where this run will write, in the order it will write. */
const targets = []
if (toWorkspace) {
  targets.push({
    label: 'workspace',
    root: path.join(WORKSPACE, '.agents', 'skills'),
  })
}
if (toUser) {
  targets.push({
    label: 'user',
    root: path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'skills'),
  })
}

if (checkOnly) {
  for (const target of targets) {
    for (const file of files) {
      const installed = await readIfPresent(path.join(target.root, file.name, 'SKILL.md'))
      const ok = installed !== undefined && gitBlobSha(installed) === file.gitSha
      console.log(`${ok ? 'OK  ' : 'DRIFT'}  ${target.label}: ${file.name}`)
    }
  }
  process.exit(0)
}

for (const target of targets) {
  await mkdir(target.root, { recursive: true })
  await install(target.root, files, extras)
  console.log(`installed ${files.length} skills -> ${target.root}`)
}

// Machine-readable provenance: which revision is on disk, and what was verified.
const provenance = {
  source: `https://github.com/${REPO}`,
  commit: COMMIT,
  license: 'MIT',
  installedAt: new Date().toISOString(),
  skills: files.map(({ name, sha256, gitSha }) => ({ name, sha256, gitBlobSha: gitSha })),
  extras: extras.map(({ file, sha256 }) => ({ file, sha256 })),
  note:
    'Installed by tools/install-skills.mjs. The portable skill set only; host-specific ' +
    'adapters were intentionally not installed.',
}
for (const target of targets) {
  await writeFile(
    path.join(target.root, 'ponytail-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )
  console.log(`wrote provenance -> ${path.join(target.root, 'ponytail-provenance.json')}`)
}
