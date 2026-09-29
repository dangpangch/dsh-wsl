/**
 * M1 acceptance: prove the whole chain works end to end.
 *
 * Chain under test:
 *   download+verify Node on Windows -> unpack inside the distribution
 *   -> deploy the helper pair and verify the copies -> launch over `wsl.exe`
 *   -> verify the protocol handshake -> `uname` reports Linux
 *
 * Unit checks for the frame codec and the `wsl -l -v` parser run first, so a
 * failure there is distinguishable from a transport failure.
 *
 * Run: node tests/m1-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FrameDecoder,
  FrameType,
  HelperError,
  HelperErrorCode,
  PROTOCOL_VERSION,
  assertHello,
  encodeFrame,
  helloMessage,
} from '../packages/dsh-wsl/lib/protocol.js'
import {
  WslConnection,
  deployHelper,
  ensureRuntime,
  fetchNodeArchive,
  listDistributions,
  parseDistributionList,
  runWsl,
  sha256,
} from '../packages/dsh-wsl/lib/connection.js'
import { NODE_ARCHIVE, NODE_SHA256 } from '../packages/dsh-wsl/lib/runtime.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER_SOURCE = path.join(HERE, '..', 'packages', 'dsh-wsl', 'helper')
const DISTRO = process.env.DSH_WSL_DISTRO || 'debian'

let failures = 0
let passes = 0

/**
 * Run one named check, reporting pass/fail without aborting the whole suite.
 *
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

/* -------------------------------------------------------------------------- */
/* unit: frame codec                                                          */
/* -------------------------------------------------------------------------- */

console.log('\nunit: frame codec')

await check('round-trips a single frame', () => {
  const frame = encodeFrame({ type: FrameType.REQUEST, id: 1, method: 'probe' })
  assert.ok(frame.length > 4, 'frame carries a length prefix plus payload')
  assert.equal(frame.readUInt32BE(0), frame.length - 4, 'length prefix counts payload bytes only')
  const decoded = new FrameDecoder().push(frame)
  assert.deepEqual(decoded, [{ type: FrameType.REQUEST, id: 1, method: 'probe' }])
})

await check('reassembles a frame split across arbitrary chunks', () => {
  const frame = encodeFrame({ type: FrameType.RESPONSE, id: 7, result: { value: 'x'.repeat(500) } })
  const decoder = new FrameDecoder()
  const seen = []
  for (let i = 0; i < frame.length; i += 7) {
    seen.push(...decoder.push(frame.subarray(i, Math.min(i + 7, frame.length))))
  }
  assert.equal(seen.length, 1, 'exactly one message from many chunks')
  assert.equal(seen[0].id, 7)
  assert.equal(seen[0].result.value.length, 500)
})

await check('drains multiple frames arriving in one chunk', () => {
  const a = encodeFrame({ type: FrameType.HEARTBEAT })
  const b = encodeFrame({ type: FrameType.REQUEST, id: 2, method: 'uname' })
  const decoded = new FrameDecoder().push(Buffer.concat([a, b]))
  assert.equal(decoded.length, 2)
  assert.equal(decoded[1].method, 'uname')
})

await check('counts length in bytes, not characters', () => {
  const message = { type: FrameType.RESPONSE, id: 3, result: { text: '中文与 emoji 🚀' } }
  const frame = encodeFrame(message)
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  assert.equal(frame.readUInt32BE(0), payload.length)
  assert.deepEqual(new FrameDecoder().push(frame)[0], message)
})

await check('rejects a payload over the ceiling without buffering it', () => {
  const huge = { type: FrameType.RESPONSE, id: 4, result: 'x'.repeat(64 * 1024 * 1024 + 16) }
  assert.throws(
    () => encodeFrame(huge),
    (error) => error instanceof HelperError && error.code === HelperErrorCode.BAD_FRAME,
  )
})

await check('refuses a declared length that cannot be resynchronized', () => {
  const evil = Buffer.alloc(8)
  evil.writeUInt32BE(0xffffffff, 0)
  assert.throws(
    () => new FrameDecoder().push(evil),
    (error) => error instanceof HelperError && error.code === HelperErrorCode.BAD_FRAME,
  )
})

await check('refuses a non-object payload', () => {
  const payload = Buffer.from('[1,2,3]', 'utf8')
  const frame = Buffer.alloc(4 + payload.length)
  frame.writeUInt32BE(payload.length, 0)
  payload.copy(frame, 4)
  assert.throws(
    () => new FrameDecoder().push(frame),
    (error) => error instanceof HelperError && error.code === HelperErrorCode.BAD_FRAME,
  )
})

/* -------------------------------------------------------------------------- */
/* unit: handshake                                                            */
/* -------------------------------------------------------------------------- */

console.log('\nunit: handshake')

await check('accepts a matching hello', () => {
  const hello = assertHello(helloMessage({ helper: 'test' }))
  assert.equal(hello.protocolVersion, PROTOCOL_VERSION)
  assert.equal(hello.platform, process.platform)
})

await check('refuses a protocol mismatch instead of guessing', () => {
  assert.throws(
    () => assertHello({ type: FrameType.HELLO, protocolVersion: PROTOCOL_VERSION + 1 }),
    (error) =>
      error instanceof HelperError && error.code === HelperErrorCode.PROTOCOL_MISMATCH,
  )
})

await check('refuses a first frame that is not a hello', () => {
  assert.throws(
    () => assertHello({ type: FrameType.REQUEST, id: 1 }),
    (error) =>
      error instanceof HelperError && error.code === HelperErrorCode.PROTOCOL_MISMATCH,
  )
})

await check('keeps the deployed helper protocol copy identical to the authoritative one', async () => {
  const { readFile } = await import('node:fs/promises')
  const authoritative = await readFile(
    path.join(HELPER_SOURCE, '..', 'lib', 'protocol.js'),
    'utf8',
  )
  const deployed = await readFile(path.join(HELPER_SOURCE, 'protocol.js'), 'utf8')
  // The helper copy carries a generated banner; strip it before comparing bodies.
  const body = deployed.slice(deployed.indexOf('\n', deployed.lastIndexOf('// Refresh with:')) + 1)
  assert.equal(
    body,
    authoritative,
    'helper/protocol.js has drifted; run: node tools/sync-helper.mjs',
  )
})

/* -------------------------------------------------------------------------- */
/* unit: wsl -l -v parsing                                                    */
/* -------------------------------------------------------------------------- */

console.log('\nunit: distribution list parsing')

await check('parses UTF-8 output and marks the default', () => {
  const rows = parseDistributionList('  NAME      STATE           VERSION\r\n* debian    Running         2\r\n')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], { name: 'debian', state: 'Running', version: '2', default: true })
})

await check('parses UTF-16LE output', () => {
  const text = '  NAME      STATE           VERSION\r\n* debian    Running         2\r\n'
  const rows = parseDistributionList(Buffer.from(text, 'utf16le'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'debian')
  assert.equal(rows[0].default, true)
})

await check('parses several distributions', () => {
  const rows = parseDistributionList(
    '  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n  debian          Stopped         1\r\n',
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].default, true)
  assert.equal(rows[1].default, false)
  assert.equal(rows[1].state, 'Stopped')
})

await check('ignores a blank and header-only input', () => {
  assert.deepEqual(parseDistributionList(''), [])
  assert.deepEqual(parseDistributionList('  NAME      STATE           VERSION\r\n'), [])
})

/* -------------------------------------------------------------------------- */
/* integration: the real chain                                                */
/* -------------------------------------------------------------------------- */

console.log('\nintegration: real distribution')

let cacheDir
let connection

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  await check('enumerates distributions and finds the target', () => {
    assert.ok(distributions.length > 0, 'at least one distribution is installed')
    assert.ok(target, `distribution "${DISTRO}" is installed`)
    assert.equal(target.version, '2', 'target is WSL2')
  })

  if (!target) throw new Error('no usable distribution; stopping integration checks')

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m1-'))

  const homeResult = await runWsl(['-d', target.name, '--', 'bash', '-lc', 'printf %s "$HOME"'])
  const homeDir = homeResult.stdout.toString('utf8').trim()
  await check('resolves the Linux home directory', () => {
    assert.match(homeDir, /^\//, `home looks like a Linux path (got ${JSON.stringify(homeDir)})`)
  })

  let runtime
  await check('provisions Node inside the distribution (push strategy)', async () => {
    const logs = []
    // The archive is ~30 MiB; give the download room to finish.
    runtime = await ensureRuntime({
      distro: target.name,
      homeDir,
      strategy: 'push',
      cacheDir,
      onLog: (line) => logs.push(line),
    })
    assert.match(runtime.version, /^v\d+\./, `Node reports a version (got ${runtime.version})`)
    assert.equal(runtime.strategy, 'push')
    console.log(`        ${logs.join(' | ')}`)
  })

  await check('downloads and verifies the pinned archive', async () => {
    // Verified independently of provisioning, which reuses an already-deployed
    // runtime and therefore does not necessarily download anything.
    const { archivePath } = await fetchNodeArchive({ cacheDir, force: true })
    const bytes = await import('node:fs/promises').then((fs) => fs.readFile(archivePath))
    assert.equal(sha256(bytes), NODE_SHA256, 'the downloaded archive matches the published checksum')
  })

  let deployed
  await check('deploys the helper pair and verifies the copies', async () => {
    deployed = await deployHelper({
      distro: target.name,
      homeDir,
      sourceDir: HELPER_SOURCE,
    })
    assert.match(deployed.helperHash, /^[0-9a-f]{64}$/)
  })

  await check('launches the helper over wsl.exe and completes the handshake', async () => {
    connection = new WslConnection({
      distro: target.name,
      helperPath: deployed.helperPath,
      nodePath: runtime.nodePath,
      requestTimeoutMs: 30_000,
    })
    await connection.start()
    assert.equal(connection.hello.platform, 'linux', 'helper reports a Linux platform')
    assert.equal(connection.hello.protocolVersion, PROTOCOL_VERSION)
  })

  await check('THE ACCEPTANCE SIGNAL: uname reports the WSL2 Linux kernel', async () => {
    const uname = await connection.request('uname')
    assert.equal(uname.sysname, 'Linux', `sysname is Linux (got ${uname.sysname})`)
    assert.match(
      uname.release,
      /microsoft-standard-WSL2/i,
      `release identifies WSL2 (got ${uname.release})`,
    )
    console.log(`        ${uname.sysname} ${uname.release} ${uname.machine}`)
    console.log(`        distro: ${uname.distro?.PRETTY_NAME ?? 'unknown'}`)
  })

  await check('reports the identity and home of the helper user', async () => {
    const user = await connection.request('user')
    assert.equal(user.home, homeDir, 'helper home matches the shell home')
    assert.ok(user.username.length > 0)
    assert.equal(user.env.WSL_DISTRO_NAME, target.name, 'helper runs inside the target distribution')
    console.log(`        ${user.username} (uid ${user.uid}) home=${user.home}`)
  })

  await check('reports resources and the /mnt mount for the Windows drives', async () => {
    const resources = await connection.request('resources')
    assert.ok(resources.cpus >= 1)
    const hasMnt = resources.mounts.some((m) => m.mountPoint === '/mnt' || m.fstype.startsWith('9p') || m.fstype === 'drvfs')
    assert.ok(hasMnt, `a /mnt or drvfs mount exists (mounts: ${JSON.stringify(resources.mounts.slice(0, 6))})`)
  })

  await check('exercises the managed-range registration path', async () => {
    const result = await connection.request('ranges.probe')
    assert.equal(result.liveDuring, 1)
    assert.equal(result.liveAfter, 0)
  })

  await check('returns a stable error code for an unknown method', async () => {
    await assert.rejects(
      () => connection.request('no.such.method'),
      (error) => error instanceof HelperError && error.code === HelperErrorCode.UNKNOWN_METHOD,
    )
  })

  await check('keeps the channel healthy across many sequential requests', async () => {
    for (let i = 0; i < 25; i++) {
      const result = await connection.request('probe')
      assert.equal(result.protocolVersion, PROTOCOL_VERSION)
    }
  })

  await check('disposes cleanly and reports the connection closed', async () => {
    await connection.dispose()
    assert.equal(connection.closed, true)
  })
} catch (error) {
  failures++
  console.log(`\nintegration aborted: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    await connection?.dispose()
  } catch {
    /* already disposed */
  }
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
