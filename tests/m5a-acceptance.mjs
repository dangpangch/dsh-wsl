/**
 * M5a acceptance: whole-profile WSL mode.
 *
 * The switch replaces host-plane services, so the load-bearing facts are:
 *   - with the local rows still live, the WSL registration is REFUSED (which is why the
 *     bundle patch disables them, and why the rows are disabled rather than shadowed)
 *   - with the slots free, the providers register and every `inject`-style consumer
 *     resolves the WSL implementation
 *   - the providers really operate inside the distribution
 *   - disposal returns the slots and releases the connection
 *
 * Run: node tests/m5a-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

import { PROVIDED_SERVICES, apply } from '../packages/dsh-wsl/index.js'
import { HELPER_SOURCE_DIR, createWslRuntime, provideHostServices } from '../packages/dsh-wsl/lib/provider.js'
import { listDistributions } from '../packages/dsh-wsl/lib/connection.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DISTRO = process.env.DSH_WSL_DISTRO || 'debian'
const BUNDLE = path.join(HERE, '..', 'packages', 'dsh-wsl-bundle')

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

/** A stand-in for `dsh-fs-local`: a host-plane provider that owns the slot. */
class LocalLikeProvider extends Service {
  /** @param {Context} ctx */
  constructor(ctx) {
    super(ctx, 'fs')
    this.label = 'local'
  }
}

console.log('\nunit: bundle composition')

await check('the bundle declares the patch that carries the switch', async () => {
  const manifest = JSON.parse(await readFile(path.join(BUNDLE, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const patch = await readFile(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')
  // Every row it must replace, disabled by id.
  for (const id of ['include:fs-local', 'include:fs-sandbox', 'include:subprocess', 'include:sandbox-local']) {
    assert.match(patch, new RegExp(`id:\\s*${id}\\b`), `${id} is addressed by the patch`)
  }
  assert.match(patch, /disabled:\s*true/, 'the replaced rows are disabled')
  assert.match(patch, /insert:/, 'the WSL row is inserted')
  assert.match(patch, /name:\s*'@local\/dsh-wsl'/)
})

await check('the plugin declares exactly the services it takes over', () => {
  assert.deepEqual([...PROVIDED_SERVICES], ['fs', 'subprocess', 'sandbox'])
})

console.log('\nunit: replacement semantics')

await check('THE REASON FOR THE PATCH: a second host row cannot take a live slot', async () => {
  const root = new Context()
  // `dsh-fs-local` mounted first, as the base bundle does.
  await root.plugin((ctx) => {
    void new LocalLikeProvider(ctx)
  })
  assert.equal(/** @type {any} */ (root.get('fs')).label, 'local')

  // The WSL provider must NOT be able to shadow it. The duplicate surfaces from the new
  // fiber, which Cordis refuses and records on the fiber rather than throwing here.
  const second = root.plugin((ctx) => {
    ctx.provide('fs', { label: 'wsl' })
  })
  await assert.rejects(() => second.await(), /has been registered/)
  assert.equal(
    /** @type {any} */ (root.get('fs')).label,
    'local',
    'the local provider kept the slot, unchanged',
  )
})

await check('with the slot free, the WSL providers register', async () => {
  const root = new Context()
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m5a-unit-'))
  try {
    const runtime = createWslRuntime({ distro: 'debian', cacheDir, helperSourceDir: HELPER_SOURCE_DIR })
    const { fs, subprocess } = provideHostServices(root, runtime)
    assert.equal(root.get('fs'), fs, 'the filesystem service resolves the WSL provider')
    assert.equal(root.get('subprocess'), subprocess, 'the subprocess service resolves the WSL provider')
    await runtime.dispose()
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

console.log('\nintegration: real distribution')

let cacheDir
let ctx
let api

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  assert.ok(target, `distribution "${DISTRO}" is installed`)

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m5a-'))
  ctx = new Context()

  await check('the plugin registers all host-plane services synchronously', () => {
    api = apply(ctx, { distro: target.name, cacheDir })
    assert.ok(ctx.get('fs'), 'fs was provided without awaiting a connection')
    assert.ok(ctx.get('subprocess'), 'subprocess was provided without awaiting a connection')
    assert.ok(ctx.get('sandbox'), 'sandbox was provided without awaiting a connection')
    assert.equal(ctx.get('fs'), api.providers.fs)
    assert.equal(ctx.get('subprocess'), api.providers.subprocess)
  })

  await check('status reports the target before connecting', () => {
    const status = api.status()
    assert.equal(status.configured.distro, target.name)
    assert.equal(status.connected, false, 'nothing is connected yet')
    assert.equal(status.lastError, null)
    assert.match(status.runtime.version, /^v\d+\./)
  })

  await check('an inject-style consumer resolves the WSL filesystem', async () => {
    const home = await api.providers.fs.resolve('~', { cwd: '/' })
    assert.ok(home, 'the tilde resolved')
    const marker = `${home.targetKey}/.cache/dsh-wsl-m5a-marker.txt`
    const file = await api.providers.fs.resolve(marker)
    await api.providers.fs.writeText(file, 'written through the host-plane provider\n')
    const readBack = await api.providers.fs.readText(file)
    assert.equal(readBack, 'written through the host-plane provider\n')
    await api.providers.fs.writeText(file, '')
  })

  await check('THE CORE: a subprocess consumer runs inside the distribution', async () => {
    const environment = await api.providers.subprocess.terminalEnvironment()
    assert.equal(environment.platform, 'posix', 'the composition reports a POSIX world')
    const handle = api.providers.subprocess.spawn({
      argv: ['uname', '-a'],
      cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 3000,
    })
    await handle.done
    const out = handle.collected.stdout.readFrom(0).text
    assert.match(out, /Linux/)
    assert.match(out, /microsoft-standard-WSL2/)
    console.log(`        ${out.trim()}`)
  })

  await check('the filesystem and subprocess providers share one execution world', async () => {
    // A path the filesystem resolved must be openable by a process in the other provider.
    const file = await api.providers.fs.resolve('/tmp/dsh-wsl-m5a-shared.txt')
    await api.providers.fs.writeText(file, 'shared\n')
    const processPath = api.providers.fs.processPath(file)
    const handle = api.providers.subprocess.spawn({
      argv: ['cat', processPath],
      cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 3000,
    })
    await handle.done
    assert.equal(handle.collected.stdout.readFrom(0).text, 'shared\n')
    await api.providers.fs.writeText(file, '')
  })

  await check('status reports the live connection after use', () => {
    const status = api.status()
    assert.equal(status.connected, true, 'the first operation connected')
    assert.equal(status.helper.platform, 'linux')
    assert.ok(status.homeDir.startsWith('/'), 'the Linux home was resolved')
  })

  await check('disposal releases the service slots', async () => {
    // The plugin owns disposal through `ctx.effect`; disposing the context runs it.
    await ctx.fiber.dispose()
    assert.equal(ctx.get('fs'), undefined, 'the filesystem slot was released')
    assert.equal(ctx.get('subprocess'), undefined, 'the subprocess slot was released')
    assert.equal(ctx.get('sandbox'), undefined, 'the sandbox slot was released')
    assert.equal(api.status().connected, false, 'the connection was closed')
  })
} catch (error) {
  failures++
  console.log(`\nintegration aborted: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    await ctx?.fiber?.dispose()
  } catch {
    /* already disposed */
  }
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
