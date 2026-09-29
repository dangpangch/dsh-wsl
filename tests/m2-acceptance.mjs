/**
 * M2 acceptance: the subprocess provider drives real processes inside the
 * distribution.
 *
 * What this proves, in order:
 *   executable lookup resolves in the distribution's namespace
 *   `terminalEnvironment` reports posix with a real shell
 *   a managed spawn runs, collects output, and reports exit facts
 *   collected output is offset-addressed and non-consuming across readers
 *   batch stdin is delivered to the child
 *   a non-zero exit is reported rather than thrown
 *   `terminate()` ends a long-running process and awaits quiescence
 *   a relative executable path is refused instead of guessed
 *   raw pipe streams are refused instead of silently degraded
 *
 * Run: node tests/m2-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WslConnection, deployHelper, ensureRuntime, listDistributions, runWsl } from '../packages/dsh-wsl/lib/connection.js'
import { WslSubprocess, scrubbedEnv } from '../packages/dsh-wsl/lib/subprocess.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER_SOURCE = path.join(HERE, '..', 'packages', 'dsh-wsl', 'helper')
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

/**
 * Spawn and await one command, returning its facts.
 *
 * @param {WslSubprocess} subprocess
 * @param {string[]} argv
 * @param {object} [overrides]
 */
async function run(subprocess, argv, overrides = {}) {
  const handle = subprocess.spawn({
    argv,
    cwd: '/tmp',
    stdio: {
      stdin: overrides.stdin ?? 'ignore',
      stdout: { maxBytes: overrides.maxBytes ?? 1 << 20 },
      stderr: { maxBytes: overrides.maxBytes ?? 1 << 20 },
    },
    graceMs: overrides.graceMs ?? 3000,
    ...overrides.spec,
  })
  const outcome = await handle.done
  return {
    handle,
    outcome,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

console.log('\nunit: environment scrub')

await check('drops credential-shaped and DSH_ names, keeps ordinary ones', () => {
  const scrubbed = scrubbedEnv({
    PATH: '/usr/bin',
    HOME: '/root',
    DEEPSEEK_API_KEY: 'secret',
    MY_TOKEN: 'secret',
    dsh_profile: 'desktop',
    DSH_HOME: '/home/x/.dsh',
    LANG: 'C.UTF-8',
  })
  assert.equal(scrubbed.PATH, '/usr/bin')
  assert.equal(scrubbed.HOME, '/root')
  assert.equal(scrubbed.LANG, 'C.UTF-8')
  for (const gone of ['DEEPSEEK_API_KEY', 'MY_TOKEN', 'dsh_profile', 'DSH_HOME']) {
    assert.ok(!(gone in scrubbed), `${gone} must not be forwarded implicitly`)
  }
})

console.log('\nintegration: real distribution')

let cacheDir
let connection
let subprocess

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  assert.ok(target, `distribution "${DISTRO}" is installed`)

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m2-'))
  const homeResult = await runWsl(['-d', target.name, '--', 'bash', '-lc', 'printf %s "$HOME"'])
  const homeDir = homeResult.stdout.toString('utf8').trim()

  const runtime = await ensureRuntime({
    distro: target.name,
    homeDir,
    strategy: 'push',
    cacheDir,
  })
  const deployed = await deployHelper({ distro: target.name, homeDir, sourceDir: HELPER_SOURCE })

  connection = new WslConnection({
    distro: target.name,
    helperPath: deployed.helperPath,
    nodePath: runtime.nodePath,
    requestTimeoutMs: 30_000,
  })
  await connection.start()

  subprocess = new WslSubprocess({ connect: async () => connection })

  await check('terminalEnvironment reports posix and a real shell', async () => {
    const env = await subprocess.terminalEnvironment()
    assert.equal(env.platform, 'posix')
    assert.match(env.defaultShell, /^\//, `shell is an absolute Linux path (got ${env.defaultShell})`)
    console.log(`        platform=${env.platform} shell=${env.defaultShell}`)
  })

  await check('resolveExecutable finds a bare name on PATH', async () => {
    const resolved = await subprocess.resolveExecutable('uname')
    assert.match(resolved, /^\//, `resolved to an absolute path (got ${resolved})`)
    console.log(`        uname -> ${resolved}`)
  })

  await check('resolveExecutable verifies an absolute path', async () => {
    const resolved = await subprocess.resolveExecutable('/bin/bash')
    assert.equal(resolved, '/bin/bash')
  })

  await check('resolveExecutable refuses a relative path instead of guessing', async () => {
    await assert.rejects(
      () => subprocess.resolveExecutable('./uname'),
      (error) => /relative executable paths are rejected/.test(error.message),
    )
  })

  await check('resolveExecutable reports a missing bare name as NOT_FOUND', async () => {
    await assert.rejects(
      () => subprocess.resolveExecutable('definitely-not-a-real-program-xyz'),
      (error) => error.code === 'NOT_FOUND',
    )
  })

  await check('spawns a process, collects stdout, and reports exit facts', async () => {
    const result = await run(subprocess, ['uname', '-a'])
    assert.equal(result.outcome.exitCode, 0, `exit code 0 (got ${result.outcome.exitCode})`)
    assert.match(result.stdout, /Linux/, 'stdout came from the Linux kernel')
    assert.match(result.stdout, /microsoft-standard-WSL2/, 'stdout identifies WSL2')
    assert.equal(result.stderr, '')
    console.log(`        ${result.stdout.trim()}`)
  })

  await check('cwd is honoured inside the distribution', async () => {
    const result = await run(subprocess, ['pwd'], { spec: { cwd: '/var' } })
    assert.equal(result.stdout.trim(), '/var')
  })

  await check('reports a non-zero exit rather than throwing', async () => {
    const result = await run(subprocess, ['bash', '-c', 'echo oops >&2; exit 3'])
    assert.equal(result.outcome.exitCode, 3)
    assert.match(result.stderr, /oops/, 'stderr was captured separately from stdout')
  })

  await check('collected output is offset-addressed and non-consuming', async () => {
    const handle = subprocess.spawn({
      argv: ['printf', 'abcdef'],
      cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: 'ignore' },
      graceMs: 3000,
    })
    await handle.done
    const reader = handle.collected.stdout
    const first = reader.readFrom(0)
    assert.equal(first.text, 'abcdef')
    assert.equal(first.lossy, false)
    // A second reader must see the same bytes: readFrom is not consuming.
    const again = reader.readFrom(0)
    assert.equal(again.text, 'abcdef')
    // Resuming from the reported offset yields only the delta.
    const delta = reader.readFrom(first.nextOffset)
    assert.equal(delta.text, '')
  })

  await check('delivers batch stdin to the child', async () => {
    const result = await run(subprocess, ['cat'], {
      stdin: { data: 'hello from the host\n' },
    })
    assert.equal(result.outcome.exitCode, 0)
    assert.equal(result.stdout, 'hello from the host\n')
  })

  await check('terminates a long-running process and awaits quiescence', async () => {
    const handle = subprocess.spawn({
      argv: ['sleep', '300'],
      cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 2000,
    })
    await handle.allocation
    assert.ok(handle.pid > 0, `a real pid was allocated (got ${handle.pid})`)
    const started = Date.now()
    handle.terminate()
    const empty = await handle.waitForExit()
    const elapsed = Date.now() - started
    assert.equal(empty, true, 'the managed range emptied')
    assert.ok(elapsed < 15_000, `termination was prompt (took ${elapsed} ms)`)
    const outcome = await handle.done
    assert.ok(
      outcome.signal !== null || outcome.exitCode !== 0,
      `a signalled process reports a signal or non-zero code (got ${JSON.stringify(outcome)})`,
    )
    console.log(`        terminated in ${elapsed} ms -> ${JSON.stringify(outcome)}`)
  })

  await check('refuses raw pipe streams instead of silently degrading', () => {
    assert.throws(
      () =>
        subprocess.spawn({
          argv: ['echo', 'x'],
          cwd: '/tmp',
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
          graceMs: 1000,
        }),
      (error) => /raw stdout streams are not supported/.test(error.message),
    )
  })

  await check('refuses a relative cwd before any remote effect', () => {
    assert.throws(
      () =>
        subprocess.spawn({
          argv: ['echo', 'x'],
          cwd: 'relative/path',
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 1000,
        }),
      (error) => /absolute path in the distribution/.test(error.message),
    )
  })

  await check('refuses an already-aborted spec', () => {
    const controller = new AbortController()
    controller.abort()
    assert.throws(
      () =>
        subprocess.spawn({
          argv: ['echo', 'x'],
          cwd: '/tmp',
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 1000,
          signal: controller.signal,
        }),
      (error) => /already aborted/.test(error.message),
    )
  })

  await check('runs many managed processes in sequence', async () => {
    for (let i = 0; i < 12; i++) {
      const result = await run(subprocess, ['printf', String(i)])
      assert.equal(result.stdout, String(i))
    }
  })

  await check('the helper still answers after all of that', async () => {
    const uname = await connection.request('uname')
    assert.equal(uname.sysname, 'Linux')
  })
} catch (error) {
  failures++
  console.log(`\nintegration aborted: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    await subprocess?.dispose()
  } catch {
    /* already disposed */
  }
  try {
    await connection?.dispose()
  } catch {
    /* already disposed */
  }
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
