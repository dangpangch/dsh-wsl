/**
 * M5b acceptance: sandbox confinement inside the distribution.
 *
 * The seam is argv-wrapping: `confine(argv, policy)` returns the argv the caller
 * spawns in place of its own, and the load-bearing facts are:
 *   - the wrapped argv carries the same bwrap profile dialect `dsh-sandbox-local`
 *     speaks on Linux, with `full` enforcement and the matching evidence
 *   - THE CORE: confinement is real inside the distribution — writes outside the
 *     policy are denied with the backend's denial signature, writes inside succeed
 *   - an unusable backend fails closed with `SANDBOX_UNAVAILABLE`, never an
 *     unwrapped argv
 *   - the runtime chain provisions the backend, so a plain connection is enough
 *
 * Run: node tests/m5b-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WslSandbox, WslSandboxUnavailableError } from '../packages/dsh-wsl/lib/sandbox.js'
import { WslSubprocess } from '../packages/dsh-wsl/lib/subprocess.js'
import { HELPER_SOURCE_DIR, createWslRuntime } from '../packages/dsh-wsl/lib/provider.js'
import { ensureBwrap, listDistributions } from '../packages/dsh-wsl/lib/connection.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DISTRO = process.env.DSH_WSL_DISTRO || 'debian'
// The workspace root lives under the Linux home on purpose: workspace-write mounts a
// private tmpfs over /tmp, so /tmp cannot carry a persistent workspace or a symlink
// that must stay visible inside the confinement.
let WS = ''
let HOME = ''

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

console.log('\nunit: policy validation happens before any remote effect')

await check('danger-full-access is refused, never silently passed through', async () => {
  const sandbox = new WslSandbox({ connect: async () => assert.fail('no connection may be opened') })
  await assert.rejects(
    () => sandbox.confine(['true'], { mode: 'danger-full-access', workspaceRoot: '/' }),
    (error) => /bypass confine\(\)/.test(error.message),
  )
})

await check('a workspaceRoot outside the distribution is refused', async () => {
  const sandbox = new WslSandbox({ connect: async () => assert.fail('no connection may be opened') })
  await assert.rejects(
    () => sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: 'C:\\Users' }),
    (error) => /absolute path in the distribution/.test(error.message),
  )
})

await check('an empty argv is refused', async () => {
  const sandbox = new WslSandbox({ connect: async () => assert.fail('no connection may be opened') })
  await assert.rejects(
    () => sandbox.confine([], { mode: 'read-only', workspaceRoot: '/tmp' }),
    (error) => /non-empty array/.test(error.message),
  )
})

console.log('\nintegration: real distribution')

let cacheDir
let runtime
let sandbox
let subprocess

/** Spawn already-confined argv and return its collected facts. */
async function runConfined(argv, cwd = '/tmp') {
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
    graceMs: 3000,
  })
  const outcome = await handle.done
  return {
    outcome,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

/** Spawn one unconfined shell command. */
async function runPlain(script) {
  const result = await runConfined(['sh', '-c', script])
  assert.equal(result.outcome.exitCode, 0, `plain shell step failed: ${result.stderr}`)
  return result
}

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  assert.ok(target, `distribution "${DISTRO}" is installed`)

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m5b-'))
  runtime = createWslRuntime({ distro: target.name, cacheDir, helperSourceDir: HELPER_SOURCE_DIR })
  const connect = async () => (await runtime.start()).connection
  sandbox = new WslSandbox({ connect })
  subprocess = new WslSubprocess({ connect })

  await check('THE RUNTIME CHAIN provisions the sandbox backend with the connection', async () => {
    // No explicit ensureBwrap call: the provider's runtime setup must bring it in.
    await runtime.start()
    const reported = runtime.status().runtime.sandbox
    assert.equal(reported.backend, 'bwrap', 'the sandbox backend is surfaced in status')
    assert.match(reported.version, /^\d+\./)
    console.log(`        bwrap ${reported.version}`)
  })

  await check('the workspace root is prepared outside any confinement', async () => {
    HOME = (await runtime.start()).homeDir
    WS = `${HOME}/.dsh_wsl/.scratch/m5b-ws`
    await runPlain(`mkdir -p ${WS}`)
  })

  await check('confine returns the reference bwrap dialect with full enforcement', async () => {
    const confined = await sandbox.confine(['echo', 'hi'], {
      mode: 'workspace-write',
      workspaceRoot: WS,
    })
    assert.ok(confined.argv[0].endsWith('/bwrap'), `the wrapped argv starts with the runner (got ${confined.argv[0]})`)
    assert.deepEqual(
      confined.argv.slice(1, 9),
      ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc'],
    )
    assert.ok(confined.argv.includes('--'), 'the profile is separated from the wrapped argv')
    assert.equal(confined.enforcement, 'full')
    assert.deepEqual(confined.denialSignatures, ['read-only file system'])
    assert.deepEqual(confined.runnerFailureRules, [{ fatalSignatures: ['bwrap: '] }])
  })

  await check('THE CORE: read-only denies a write with the backend denial signature', async () => {
    const confined = await sandbox.confine(
      ['touch', '/usr/dsh-wsl-m5b-denied'],
      { mode: 'read-only', workspaceRoot: '/tmp' },
    )
    const result = await runConfined(confined.argv)
    assert.notEqual(result.outcome.exitCode, 0, 'the write did not succeed')
    assert.match(result.stderr, /read-only file system/i, 'the denial matches the announced signature')
  })

  await check('read-only still permits reading and the /dev/null sink', async () => {
    const confined = await sandbox.confine(
      ['sh', '-c', 'cat /etc/hostname > /dev/null && echo readable'],
      { mode: 'read-only', workspaceRoot: '/tmp' },
    )
    const result = await runConfined(confined.argv)
    assert.equal(result.outcome.exitCode, 0, `exit 0 (got ${result.outcome.exitCode}: ${result.stderr})`)
    assert.equal(result.stdout.trim(), 'readable')
  })

  await check('workspace-write allows the workspace and /tmp, denies elsewhere', async () => {
    const confined = await sandbox.confine(
      ['sh', '-c', `echo inside > ${WS}/ok.txt && touch /tmp/t-ok && touch /var/dsh-wsl-m5b-denied`],
      { mode: 'workspace-write', workspaceRoot: WS },
    )
    const result = await runConfined(confined.argv)
    assert.notEqual(result.outcome.exitCode, 0, 'the out-of-policy write was denied')
    assert.match(result.stderr, /read-only file system/i)
    // The workspace write committed before the denial (the filesystem is one shared
    // world); the tmpfs write is verifiable only inside a confinement, so a second
    // confined run proves /tmp is writable there at all.
    const persisted = await runPlain(`cat ${WS}/ok.txt`)
    assert.match(persisted.stdout, /inside/)
    const tmpfs = await runConfined(
      (await sandbox.confine(['sh', '-c', 'touch /tmp/second-run && echo tmp-writable'], {
        mode: 'workspace-write',
        workspaceRoot: WS,
      })).argv,
    )
    assert.equal(tmpfs.outcome.exitCode, 0, `/tmp writable under workspace-write (${tmpfs.stderr})`)
    assert.match(tmpfs.stdout, /tmp-writable/)
  })

  await check('a symlinked workspace root is canonicalized before the bind', async () => {
    // The real directory and its symlink live under the home, which stays a read-only
    // bind inside the confinement, so the symlink itself remains visible there.
    const real = `${HOME}/.dsh_wsl/.scratch/m5b-real`
    const link = `${HOME}/.dsh_wsl/.scratch/m5b-link`
    await runPlain(`mkdir -p ${real} && ln -sfn ${real} ${link}`)
    const confined = await sandbox.confine(
      ['sh', '-c', `echo via-link > ${link}/through.txt`],
      { mode: 'workspace-write', workspaceRoot: link },
    )
    const result = await runConfined(confined.argv)
    assert.equal(result.outcome.exitCode, 0, `write through the symlinked root (${result.stderr})`)
    const persisted = await runPlain(`cat ${real}/through.txt`)
    assert.match(persisted.stdout, /via-link/)
  })

  await check('an unusable runner fails closed with SANDBOX_UNAVAILABLE', async () => {
    const connection = await connect()
    await assert.rejects(
      () =>
        connection.request('sandbox.confine', {
          argv: ['true'],
          mode: 'read-only',
          workspaceRoot: '/tmp',
          bwrapPath: '/nonexistent/bwrap',
        }),
      (error) => error.appCode === 'SANDBOX_UNAVAILABLE',
    )
  })

  await check('the appCode refusal maps to WslSandboxUnavailableError at the seam', async () => {
    const broken = new WslSandbox({
      connect: async () => ({
        request: async () => {
          const error = new Error('sandbox: no sandbox runner at /gone')
          error.appCode = 'SANDBOX_UNAVAILABLE'
          throw error
        },
      }),
    })
    await assert.rejects(
      () => broken.confine(['true'], { mode: 'read-only', workspaceRoot: '/tmp' }),
      (error) => error instanceof WslSandboxUnavailableError && error.code === 'SANDBOX_UNAVAILABLE',
    )
  })

  await check('confined, plain and filesystem effects share one execution world', async () => {
    const confined = await sandbox.confine(
      ['sh', '-c', 'echo confined > /tmp/dsh-wsl-m5b-shared.txt'],
      { mode: 'workspace-write', workspaceRoot: '/tmp' },
    )
    const result = await runConfined(confined.argv)
    assert.equal(result.outcome.exitCode, 0, `confined write (${result.stderr})`)
    const read = subprocess.spawn({
      argv: ['cat', '/tmp/dsh-wsl-m5b-shared.txt'],
      cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 3000,
    })
    await read.done
    assert.equal(read.collected.stdout.readFrom(0).text, 'confined\n')
  })

  await check('ensureBwrap is idempotent', async () => {
    const home = (await runtime.start()).homeDir
    const first = await ensureBwrap({ distro: target.name, homeDir: home, cacheDir })
    const second = await ensureBwrap({ distro: target.name, homeDir: home, cacheDir })
    assert.equal(second.bwrapPath, first.bwrapPath)
    assert.equal(second.version, first.version)
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
