/**
 * M6 acceptance: skills / MCP / plugins under the WSL profile.
 *
 * What the investigation (PLAN §4.7) established:
 *   - with a filesystem service present, `dsh-skill-filesystem` performs ALL
 *     non-trustedHost discovery and body reads through `ctx.fs` — under the WSL
 *     profile those route through the distribution
 *   - MCP stdio servers spawn on the HOST via the MCP SDK's own child_process; profile
 *     plugins are host cordis rows. Neither routes through the seams, so neither needs
 *     a sync pipeline — the M0-era "Skill/MCP/Plugin 同步" collapses to seam compliance.
 *
 * What must hold, tested against the real distribution and the real repository:
 *   - the exact call sequence skill-filesystem makes (resolve → stat → listDir →
 *     stat → processPath/readText) works for a real skill root: this repo's
 *     `.agents/skills` with the ponytail skill in it
 *   - an absent root degrades to the FS_NOT_FOUND / FS_NOT_DIRECTORY vocabulary the
 *     provider treats as empty, never a crash
 *   - a Linux session cwd mangled by host `path.resolve()` (`D:\mnt\d\…`) recovers its
 *     project root instead of silently losing every project skill
 *
 * Run: node tests/m6-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

import { createWslRuntime, provideHostServices, HELPER_SOURCE_DIR } from '../packages/dsh-wsl/lib/provider.js'
import { listDistributions } from '../packages/dsh-wsl/lib/connection.js'
import { windowsToLinux } from '../packages/dsh-wsl/lib/paths.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE) // D:\workspace\dsh\dsh-wsl on this machine
const DISTRO = process.env.DSH_WSL_DISTRO || 'debian'

let failures = 0
let passes = 0

/**
 * @param {string} name
 * @param {() => Promise<void>|void} fn
 */
async function check(name, fn) {
  try {
    await fn()
    passes++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error instanceof Error ? error.message : String(error)}`)
  }
}

let cacheDir
let runtime
let fs

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  assert.ok(target, `distribution "${DISTRO}" is installed`)

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m6-'))
  runtime = createWslRuntime({
    distro: target.name,
    cacheDir,
    helperSourceDir: HELPER_SOURCE_DIR,
  })
  const root = new Context()
  ;({ fs } = provideHostServices(root, runtime))

  await check('THE SEQUENCE: skill discovery walks .git and lists the project skill root', async () => {
    // Replica of findProjectRoot + listSkillRootEntriesFromFileSystem from
    // dsh-skill-filesystem, with the host cwd this harness passes for this repository.
    const cwd = `${REPO}\\tests`
    let current = cwd
    for (;;) {
      const candidate = await fs.resolve(`${current}\\.git`)
      if ((await fs.stat(candidate)) !== undefined) break
      const parent = path.dirname(current)
      assert.notEqual(parent, current, 'project root walk reached the drive root without .git')
      current = parent
    }
    assert.equal(current, REPO, 'the nearest .git ancestor is the repository root')

    const skillsRoot = await fs.resolve(`${REPO}\\.agents\\skills`)
    const entries = await fs.listDir(skillsRoot)
    const ponytail = entries.find((entry) => entry.name === 'ponytail')
    assert.ok(ponytail, `.agents/skills lists the ponytail skill (got: ${entries.map((e) => e.name).join(', ')})`)
    assert.equal(ponytail.type, 'directory')
    assert.ok(ponytail.target.displayPath.startsWith('/'), 'entries carry Linux display paths')
  })

  await check('THE BODY: a discovered skill loads through the same seam', async () => {
    const skillFile = await fs.resolve(`${REPO}\\.agents\\skills\\ponytail\\SKILL.md`)
    const info = await fs.stat(skillFile)
    assert.equal(info.type, 'file', 'SKILL.md stats as a regular file')
    const content = await fs.readText(skillFile)
    assert.match(content, /^---\n/, 'the body keeps its YAML frontmatter')
    assert.match(content, /^name:\s*ponytail$/m, 'the frontmatter names the skill')
    // readSkillText returns `fs.processPath(target)` as the instruction-file path.
    assert.ok(fs.processPath(skillFile).startsWith('/'), 'processPath is the Linux coordinate')
  })

  await check('ABSENT ROOTS: degrade to the empty-catalog error vocabulary', async () => {
    // resolve is pure canonicalization; absence surfaces at listDir, whose
    // FS_NOT_FOUND / FS_NOT_DIRECTORY codes are exactly what listSkillRootEntries
    // catches to produce an empty catalog.
    const absent = await fs.listDir(await fs.resolve(`${REPO}\\.dsh\\skills`)).catch((error) => error)
    assert.ok(
      absent.code === 'FS_NOT_FOUND' || absent.code === 'FS_NOT_DIRECTORY',
      `a missing root reports the absent vocabulary (got ${absent.code ?? 'success'})`,
    )
  })

  await check('THE USER ROOT: the Windows profile is reachable through the distro', async () => {
    // dshHome defaults to `<host>~/.dsh`; skill-filesystem hands that Windows path to
    // ctx.fs, which must map it onto the drvfs mount and find the real profile.
    const profile = await fs.resolve('C:\\Users\\13409\\.dsh')
    const info = await fs.stat(profile)
    assert.equal(info.type, 'directory', 'the profile directory exists over /mnt/c')
    assert.equal(profile.targetKey, '/mnt/c/Users/13409/.dsh')
  })

  await check('THE MANGLE: a host-resolved Linux cwd recovers its project root', async () => {
    // path.win32.resolve('/mnt/d/workspace/dsh/dsh-wsl') → 'D:\mnt\d\workspace\dsh\dsh-wsl'.
    // Without the undo, findProjectRoot walks a nonexistent tree and every project
    // skill silently disappears.
    const mangled = 'D:\\mnt\\d\\workspace\\dsh\\dsh-wsl\\.git'
    const recovered = await fs.resolve(mangled)
    assert.equal(recovered.targetKey, '/mnt/d/workspace/dsh/dsh-wsl/.git')
    assert.ok((await fs.stat(recovered)) !== undefined, 'the recovered path really exists')
  })

  await check('THE HEURISTIC: ordinary Windows paths still map by drive', async () => {
    assert.equal(windowsToLinux('D:\\workspace\\dsh'), '/mnt/d/workspace/dsh')
    assert.equal(windowsToLinux('D:/mnt/d/ws'), '/mnt/d/ws', 'the undo accepts forward slashes')
    assert.equal(windowsToLinux('D:\\Mnt\\d\\ws'), '/mnt/d/Mnt/d/ws', 'case-sensitive: Mnt is a real Windows dir')
    assert.equal(windowsToLinux('D:\\mnt'), '/mnt')
  })
} catch (error) {
  failures++
  console.log(`\nintegration aborted: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    await runtime?.dispose()
  } catch {
    /* already disposed */
  }
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
