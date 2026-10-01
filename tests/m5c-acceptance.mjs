/**
 * M5c acceptance: robustness close-out.
 *
 * Stage 1 — dead-connection recovery. The M4 review fixed "connect() caches a resolved
 * value forever" in the realm code that M5a deleted; this stage re-lands that fix in
 * `createWslRuntime` and the two caching providers. The load-bearing facts:
 *   - killing the helper invalidates the cached setup (the next start() rebuilds, with a
 *     NEW helper pid — not the dead one)
 *   - a filesystem provider holding a dead cached connection recovers on its next
 *     operation instead of failing forever
 *
 * Run: node tests/m5c-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

import { createWslRuntime, provideHostServices, HELPER_SOURCE_DIR } from '../packages/dsh-wsl/lib/provider.js'
import { listDistributions, runWsl, withProvisionLock } from '../packages/dsh-wsl/lib/connection.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
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

/** Kill the helper process inside the distribution, simulating a crash. */
function killHelper(distro, pid) {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', distro, '--', 'kill', '-9', String(pid)], {
      windowsHide: true,
    })
    child.on('error', reject)
    child.on('close', () => resolve())
  })
}

/** Resolve once the connection has failed (or immediately if it already has). */
function waitForClose(connection) {
  if (connection.closed) return Promise.resolve()
  return new Promise((resolve) => connection.onClose(resolve))
}

let cacheDir
let runtime

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  assert.ok(target, `distribution "${DISTRO}" is installed`)

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m5c-'))
  runtime = createWslRuntime({
    distro: target.name,
    cacheDir,
    helperSourceDir: HELPER_SOURCE_DIR,
  })

  await check('THE SETUP: the runtime connects and the helper is alive', async () => {
    const state = await runtime.start()
    assert.equal(state.connection.closed, false)
    assert.ok(state.connection.hello.pid > 0, 'the helper reported its pid')
  })

  await check('THE RECOVERY: start() after the helper died rebuilds a NEW connection', async () => {
    const first = await runtime.start()
    const deadPid = first.connection.hello.pid

    await killHelper(target.name, deadPid)
    await waitForClose(first.connection)
    assert.equal(first.connection.closed, true, 'the transport noticed the kill')

    const second = await runtime.start()
    assert.notEqual(
      second.connection.hello.pid,
      deadPid,
      'the helper was relaunched, not handed back dead',
    )
    assert.equal(second.connection.closed, false)
  })

  await check('THE PROVIDER: a filesystem consumer recovers on its next operation', async () => {
    const root = new Context()
    const { fs } = provideHostServices(root, runtime)

    // Cache a live connection, then kill the helper out from under it.
    const first = await fs.resolve('~', { cwd: '/' })
    const connection = (await runtime.start()).connection
    await killHelper(target.name, connection.hello.pid)
    await waitForClose(connection)

    // THE assertion: the same provider object, holding a dead cached connection,
    // must succeed on the next operation — reconnect, not `connection is closed` forever.
    const marker = `${first.targetKey}/.cache/dsh-wsl-m5c-marker.txt`
    const file = await fs.resolve(marker)
    await fs.writeText(file, 'recovered\n')
    assert.equal(await fs.readText(file), 'recovered\n')
    await fs.writeText(file, '')
  })

  await check('disposal after recovery stays clean', async () => {
    const state = await runtime.start()
    assert.equal(state.connection.closed, false)
    await runtime.dispose()
    assert.equal(runtime.status().connected, false)
  })

  await check('THE LOCK: concurrent provisioning serializes in the distribution', async () => {
    const lockPath = `${(await runtime.start()).homeDir}/.local/share/dsh-wsl/.${target.name}.lock.m5c`
    const events = []
    const work = (name) => async () => {
      events.push(`start:${name}`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      events.push(`end:${name}`)
    }
    await Promise.all([
      withProvisionLock({ distro: target.name, lockPath }, work('a')),
      withProvisionLock({ distro: target.name, lockPath }, work('b')),
    ])
    // Whichever won, its `end` must precede the other's `start` — that is the mutex.
    const [s1, e1, s2, e2] = events
    assert.match(s1, /^start:/)
    assert.equal(
      e1,
      s1.replace('start:', 'end:'),
      `the first section must complete before the second begins: ${events.join(' ')}`,
    )
    assert.equal(e2, s2.replace('start:', 'end:'))
  })

  await check('THE LOCK: a stale lock is stolen, not waited on', async () => {
    const home = (await runtime.start()).homeDir
    const lockPath = `${home}/.local/share/dsh-wsl/.${target.name}.lock.m5c-stale`
    // Backdate the lock past the staleness window, as a killed holder would leave it.
    await runWsl([
      '-d',
      target.name,
      '--',
      'bash',
      '-lc',
      `mkdir -p '${lockPath}' && touch -d '10 minutes ago' '${lockPath}'`,
    ])
    const started = Date.now()
    await withProvisionLock({ distro: target.name, lockPath }, async () => {})
    assert.ok(
      Date.now() - started < 5_000,
      'the stale lock was stolen immediately instead of timing out',
    )
  })

  await check('THE NORMALIZATION: an empty configured distro resolves to the canonical target', async () => {
    // No distro configured: must resolve to the system default and land every deployed
    // asset in the SAME ~/.local/share/dsh-wsl/<distro>/ tree an explicit connection uses —
    // not in a trailing-empty-segment sibling directory with its own duplicate deployment.
    const defaultRuntime = createWslRuntime({
      cacheDir,
      helperSourceDir: HELPER_SOURCE_DIR,
    })
    try {
      const state = await defaultRuntime.start()
      assert.equal(defaultRuntime.distro, target.name, 'the default resolved to the real name')

      // The canonical tree holds the helper this connection is actually talking to.
      const helperOnCanonicalPath = `${state.homeDir}/.local/share/dsh-wsl/${target.name}/helper/wsl-helper.mjs`
      const probe = await runWsl([
        '-d',
        target.name,
        '--',
        'bash',
        '-lc',
        `test -f '${helperOnCanonicalPath}' && printf PRESENT`,
      ])
      assert.equal(
        probe.stdout.toString('utf8').trim(),
        'PRESENT',
        'the default-distro connection deployed into the canonical directory',
      )
    } finally {
      await defaultRuntime.dispose()
    }
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
