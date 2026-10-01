/**
 * M7 acceptance: packaging and the install_bundle chain.
 *
 * The official install path is `plugin_manager` `action: install_bundle` with an
 * absolute package directory (cordis-plugin-development skill). It refuses `workspace:*`
 * dependencies — the profile's pnpm cannot resolve them — so the installable unit is
 * ONE self-contained package named `@local/dsh-wsl`: plugin runtime + helper + patch +
 * locale, zero dependencies. What must hold:
 *   - the packed layout preserves the helper's relative location (lib/provider.js
 *     reaches ../helper) and the helper protocol copy is byte-identical
 *   - the packed manifest satisfies the bundle contract (dsh.bundle.patch, no deps,
 *     row name = package name) and the patch still disables the four replaced rows
 *   - THE PROOF: importing the PACKED index.js and calling apply() against the real
 *     distribution registers the providers and serves a real filesystem operation —
 *     the artifact handed to install_bundle is the working plugin, not a copy drift
 *
 * Run: node tests/m7-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

import {
  PACKAGED_NAME,
  REPLACED_ROW_IDS,
  REQUIRED_HELPER_FILES,
  defaultOutDir,
  packBundle,
  verifyBundle,
} from '../tools/pack-bundle.mjs'
import { listDistributions } from '../packages/dsh-wsl/lib/connection.js'

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

let cacheDir
let packedDir
let ctx

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  assert.ok(target, `distribution "${DISTRO}" is installed`)

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m7-'))
  packedDir = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m7-pack-')), PACKAGED_NAME.split('/')[1])
  await packBundle(packedDir)

  await check('THE CONTRACT: the packed manifest satisfies the bundle requirements', async () => {
    assert.deepEqual(await verifyBundle(packedDir), [], 'verifyBundle reports no problems')
  })

  await check('THE LAYOUT: the helper rides along in its relative position', async () => {
    const packed = await import(pathToFileURL(path.join(packedDir, 'lib', 'provider.js')).href)
    assert.equal(
      path.resolve(packed.HELPER_SOURCE_DIR),
      path.resolve(path.join(packedDir, 'helper')),
      'HELPER_SOURCE_DIR resolves inside the packed package',
    )
    // Existence only: those files execute inside the distribution; their syntax is
    // already covered by verifyBundle's node --check.
    for (const name of REQUIRED_HELPER_FILES) {
      await assert.doesNotReject(() => stat(path.join(packedDir, 'helper', name)))
    }
  })

  await check('THE INSTALL: apply() from the PACKED package serves the real distribution', async () => {
    const packed = await import(pathToFileURL(path.join(packedDir, 'index.js')).href)
    assert.equal(typeof packed.apply, 'function', 'the packed entry exports apply')

    ctx = new Context()
    const api = packed.apply(ctx, { distro: target.name, cacheDir })
    assert.equal(ctx.get('fs'), api.providers.fs, 'the packed row provides fs')
    assert.equal(ctx.get('subprocess'), api.providers.subprocess)
    assert.equal(ctx.get('sandbox'), api.providers.sandbox)

    // One real filesystem operation through the packed artifact.
    const home = await api.providers.fs.resolve('~', { cwd: '/' })
    assert.ok(home.targetKey.startsWith('/'), 'the packed plugin talks to the distribution')
    const status = api.status()
    assert.equal(status.connected, true)
    assert.equal(status.helper.platform, 'linux')
  })

  await check('THE DEFAULTS: packing without arguments lands in dist/dsh-wsl', () => {
    assert.equal(defaultOutDir(), path.join(path.dirname(HERE), 'dist', 'dsh-wsl'))
    assert.equal(PACKAGED_NAME, '@local/dsh-wsl')
    assert.equal(REPLACED_ROW_IDS.length, 4)
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
  if (packedDir) await rm(path.dirname(packedDir), { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
