/**
 * M3 acceptance: the filesystem provider works on real distro storage.
 *
 * Unit checks for path translation run first, because a mistranslation here would
 * silently target a different file rather than fail. Integration checks then exercise
 * the semantics that make the provider trustworthy: realpath identity, version
 * tokens that change on rewrite, guarded writes, atomic literal edits with
 * line-ending preservation, and the full `FsErrorCode` taxonomy.
 *
 * Run: node tests/m3-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WslConnection, deployHelper, ensureRuntime, listDistributions, runWsl } from '../packages/dsh-wsl/lib/connection.js'
import { WslFileSystem } from '../packages/dsh-wsl/lib/fs.js'
import {
  expandHome,
  isWindowsBackedPath,
  joinLinux,
  linuxToWindows,
  windowsToLinux,
} from '../packages/dsh-wsl/lib/paths.js'

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

/* -------------------------------------------------------------------------- */
/* unit: path translation                                                     */
/* -------------------------------------------------------------------------- */

console.log('\nunit: Windows -> Linux')

await check('maps a drive path to /mnt', () => {
  assert.equal(windowsToLinux('D:\\workspace\\proj'), '/mnt/d/workspace/proj')
  assert.equal(windowsToLinux('C:/Users/me/a.txt'), '/mnt/c/Users/me/a.txt')
})

await check('maps a bare drive root', () => {
  assert.equal(windowsToLinux('D:\\'), '/mnt/d')
  assert.equal(windowsToLinux('D:'), '/mnt/d')
})

await check('maps UNC wsl paths to Linux paths', () => {
  assert.equal(windowsToLinux('\\\\wsl$\\debian\\home\\pang'), '/home/pang')
  assert.equal(windowsToLinux('\\\\wsl.localhost\\debian\\var\\log'), '/var/log')
  assert.equal(windowsToLinux('\\\\wsl$\\debian'), '/')
})

await check('passes an already-Linux path through', () => {
  assert.equal(windowsToLinux('/home/pang/x'), '/home/pang/x')
})

await check('refuses a drive-relative path instead of guessing', () => {
  assert.equal(windowsToLinux('C:relative'), undefined)
})

await check('refuses a plain relative path', () => {
  assert.equal(windowsToLinux('relative\\path'), undefined)
})

await check('refuses empty input', () => {
  assert.equal(windowsToLinux(''), undefined)
  assert.equal(windowsToLinux(undefined), undefined)
})

console.log('\nunit: Linux -> Windows')

await check('maps /mnt back to a drive path', () => {
  assert.equal(linuxToWindows('/mnt/d/workspace/proj', 'debian'), 'D:\\workspace\\proj')
  assert.equal(linuxToWindows('/mnt/c', 'debian'), 'C:\\')
})

await check('maps native Linux storage to a wsl$ UNC path', () => {
  assert.equal(linuxToWindows('/home/pang/x', 'debian'), '\\\\wsl$\\debian\\home\\pang\\x')
  assert.equal(linuxToWindows('/home/pang', 'debian'), '\\\\wsl$\\debian\\home\\pang')
})

await check('round-trips a drive path', () => {
  const original = 'D:\\workspace\\dsh\\dsh-wsl'
  const linux = windowsToLinux(original)
  assert.equal(linuxToWindows(linux, 'debian'), original)
})

await check('refuses a relative Linux path', () => {
  assert.equal(linuxToWindows('relative/x', 'debian'), undefined)
})

console.log('\nunit: drvfs detection and helpers')

await check('flags /mnt paths as Windows-backed', () => {
  assert.equal(isWindowsBackedPath('/mnt/d/x'), true)
  assert.equal(isWindowsBackedPath('/mnt/c'), true)
  assert.equal(isWindowsBackedPath('/home/pang/x'), false)
  assert.equal(isWindowsBackedPath('/mntx/d'), false)
})

await check('expands ~ only against a known home', () => {
  assert.equal(expandHome('~/x', '/home/pang').path, '/home/pang/x')
  assert.equal(expandHome('~', '/home/pang').path, '/home/pang')
  assert.equal(expandHome('~other/x', '/home/pang').expanded, false)
})

await check('joins and lexically normalizes without escaping the root', () => {
  assert.equal(joinLinux('/a/b', 'c/d'), '/a/b/c/d')
  assert.equal(joinLinux('/a/b', '../c'), '/a/c')
  assert.equal(joinLinux('/a/b', '/abs'), '/abs')
  assert.equal(joinLinux('/a', '../../..'), '/')
})

/* -------------------------------------------------------------------------- */
/* integration: real distro storage                                           */
/* -------------------------------------------------------------------------- */

console.log('\nintegration: real distribution storage')

let cacheDir
let connection
let fs
let workDir

try {
  const distributions = await listDistributions()
  const target = distributions.find((d) => d.name === DISTRO) ?? distributions.find((d) => d.default)
  assert.ok(target, `distribution "${DISTRO}" is installed`)

  cacheDir = await mkdtemp(path.join(tmpdir(), 'dsh-wsl-m3-'))
  const homeResult = await runWsl(['-d', target.name, '--', 'bash', '-lc', 'printf %s "$HOME"'])
  const homeDir = homeResult.stdout.toString('utf8').trim()

  const runtime = await ensureRuntime({ distro: target.name, homeDir, strategy: 'push', cacheDir })
  const deployed = await deployHelper({ distro: target.name, homeDir, sourceDir: HELPER_SOURCE })

  connection = new WslConnection({
    distro: target.name,
    helperPath: deployed.helperPath,
    nodePath: runtime.nodePath,
    requestTimeoutMs: 30_000,
  })
  await connection.start()

  fs = new WslFileSystem({
    connect: async () => connection,
    distro: target.name,
    cwd: homeDir,
  })

  workDir = path.posix.join(homeDir, '.dsh_wsl', '.scratch', `m3-${Date.now()}`)
  await runWsl(['-d', target.name, '--', 'bash', '-lc', `mkdir -p '${workDir}'`])

  await check('resolves a path to a stable target', async () => {
    const target_ = await fs.resolve(workDir)
    assert.equal(target_.targetKey, workDir, 'the canonical key is the realpath')
    assert.equal(target_.displayPath, workDir)
  })

  await check('THE CORE: identity is stable across path aliases', async () => {
    const direct = await fs.resolve(`${workDir}/../${path.posix.basename(workDir)}`)
    const plain = await fs.resolve(workDir)
    assert.equal(direct.targetKey, plain.targetKey, 'a `..` alias yields the same targetKey')
  })

  await check('resolves an absent file without failing, for guarded creation', async () => {
    const target_ = await fs.resolve(`${workDir}/not-yet.txt`)
    assert.equal(target_.targetKey, `${workDir}/not-yet.txt`)
    assert.equal(await fs.stat(target_), undefined, 'stat reports absence')
  })

  await check('writes a new file and reports a create with its version', async () => {
    const target_ = await fs.resolve(`${workDir}/hello.txt`)
    const outcome = await fs.writeText(target_, 'first line\nsecond line\n')
    assert.equal(outcome.operation, 'create')
    assert.equal(outcome.before, null, 'a create has no prior basis')
    assert.equal(outcome.after, 'first line\nsecond line\n')
    assert.match(outcome.version, /^\d+:\d+:/)
    assert.equal(await fs.readText(target_), 'first line\nsecond line\n')
  })

  await check('guarded create rejects an existing file with FS_NOT_OBSERVED', async () => {
    const target_ = await fs.resolve(`${workDir}/hello.txt`)
    await assert.rejects(
      () => fs.writeText(target_, 'nope', { kind: 'createIfAbsent' }),
      (error) => error.code === 'FS_NOT_OBSERVED',
    )
  })

  await check('guarded replace rejects a stale version with FS_STALE_VERSION', async () => {
    const target_ = await fs.resolve(`${workDir}/guarded.txt`)
    const created = await fs.writeText(target_, 'v1')
    // A guarded write with a version that never existed must fail.
    await assert.rejects(
      () => fs.writeText(target_, 'v2', { kind: 'replaceIfVersion', version: 'nonsense' }),
      (error) => error.code === 'FS_STALE_VERSION',
    )
    // The correct version succeeds, and the version advances.
    const updated = await fs.writeText(target_, 'v2', {
      kind: 'replaceIfVersion',
      version: created.version,
    })
    assert.equal(updated.operation, 'update')
    assert.equal(updated.after, 'v2')
    assert.equal(updated.before, 'v1', 'an overwrite carries its LF-normalized basis')
    assert.notEqual(updated.version, created.version, 'the version token advanced')
  })

  await check('THE VERSION GUARD: a rewrite is detected even at equal size', async () => {
    const target_ = await fs.resolve(`${workDir}/version.txt`)
    const first = await fs.writeText(target_, 'AAAA')
    assert.equal((await fs.stat(target_)).version, first.version)
    // Sleep past the coarse filesystem timestamp so ctime can move.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await fs.writeText(target_, 'BBBB')
    assert.notEqual(second.version, first.version, 'the version changed for a same-size rewrite')
    await assert.rejects(
      () => fs.writeText(target_, 'CCCC', { kind: 'replaceIfVersion', version: first.version }),
      (error) => error.code === 'FS_STALE_VERSION',
    )
  })

  await check('lists a directory in stable name order with types', async () => {
    // Isolate the listing in its own directory so unrelated scratch files cannot
    // change the expectation.
    const listDir = `${workDir}/listing`
    await runWsl(['-d', target.name, '--', 'bash', '-lc', `mkdir -p '${listDir}/subdir'`])
    await fs.writeText(await fs.resolve(`${listDir}/b.txt`), 'b')
    await fs.writeText(await fs.resolve(`${listDir}/a.txt`), 'a')
    const entries = await fs.listDir(await fs.resolve(listDir))
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['a.txt', 'b.txt', 'subdir'],
      'listing is name-ordered and excludes our own staging directory',
    )
    assert.equal(entries.find((e) => e.name === 'subdir').type, 'directory')
    assert.equal(entries.find((e) => e.name === 'a.txt').type, 'file')
    assert.equal(entries.find((e) => e.name === 'a.txt').size, 1)
    assert.ok(entries.find((e) => e.name === 'a.txt').target.targetKey.endsWith('/a.txt'))
  })

  await check('edits literal text and reports before/after', async () => {
    const target_ = await fs.resolve(`${workDir}/edit.txt`)
    await fs.writeText(target_, 'alpha\nbeta\ngamma\n')
    const outcome = await fs.editText(target_, {
      oldString: 'beta',
      newString: 'BETA',
      replaceAll: false,
    })
    assert.equal(outcome.before, 'alpha\nbeta\ngamma\n')
    assert.equal(outcome.after, 'alpha\nBETA\ngamma\n')
  })

  await check('preserves CRLF line endings across an edit', async () => {
    const target_ = await fs.resolve(`${workDir}/crlf.txt`)
    // Write CRLF directly through the shell so the raw bytes are known.
    await runWsl([
      '-d', target.name, '--', 'bash', '-lc',
      `printf 'one\\r\\ntwo\\r\\nthree\\r\\n' > '${workDir}/crlf.txt'`,
    ])
    const outcome = await fs.editText(target_, {
      oldString: 'two',
      newString: 'TWO',
      replaceAll: false,
    })
    assert.equal(outcome.before, 'one\ntwo\nthree\n', 'matching happens on LF-normalized text')
    assert.equal(outcome.after, 'one\nTWO\nthree\n')
    // The published file must still be CRLF.
    const raw = await runWsl([
      '-d', target.name, '--', 'bash', '-lc',
      `od -c '${workDir}/crlf.txt' | head -3`,
    ])
    assert.match(raw.stdout.toString('utf8'), /\\r/, 'the file is still CRLF on disk')
  })

  await check('rejects a non-unique edit with FS_AMBIGUOUS_EDIT', async () => {
    const target_ = await fs.resolve(`${workDir}/ambiguous.txt`)
    await fs.writeText(target_, 'x\nx\n')
    await assert.rejects(
      () => fs.editText(target_, { oldString: 'x', newString: 'y', replaceAll: false }),
      (error) => error.code === 'FS_AMBIGUOUS_EDIT',
    )
  })

  await check('replaceAll rewrites every occurrence', async () => {
    const target_ = await fs.resolve(`${workDir}/ambiguous.txt`)
    const outcome = await fs.editText(target_, { oldString: 'x', newString: 'y', replaceAll: true })
    assert.equal(outcome.after, 'y\ny\n')
  })

  await check('reports FS_EDIT_NOT_FOUND for a missing needle', async () => {
    const target_ = await fs.resolve(`${workDir}/edit.txt`)
    await assert.rejects(
      () => fs.editText(target_, { oldString: 'zzz', newString: 'q', replaceAll: false }),
      (error) => error.code === 'FS_EDIT_NOT_FOUND',
    )
  })

  await check('reports FS_EDIT_NOT_FOUND for an empty needle', async () => {
    const target_ = await fs.resolve(`${workDir}/edit.txt`)
    await assert.rejects(
      () => fs.editText(target_, { oldString: '', newString: 'q', replaceAll: false }),
      (error) => /non-empty/.test(error.message),
    )
  })

  await check('stale edit is reported as stale, never as a missing needle', async () => {
    const target_ = await fs.resolve(`${workDir}/edit.txt`)
    await assert.rejects(
      () => fs.editText(target_, { oldString: 'alpha', newString: 'A', replaceAll: false }, { version: 'bogus' }),
      (error) => error.code === 'FS_STALE_VERSION',
    )
  })

  await check('reports FS_STALE_VERSION when editing an absent file', async () => {
    const target_ = await fs.resolve(`${workDir}/missing-edit.txt`)
    await assert.rejects(
      () => fs.editText(target_, { oldString: 'a', newString: 'b', replaceAll: false }),
      (error) => error.code === 'FS_STALE_VERSION',
    )
  })

  await check('reports FS_NOT_FOUND when reading an absent file', async () => {
    const target_ = await fs.resolve(`${workDir}/absent.txt`)
    await assert.rejects(
      () => fs.readText(target_),
      (error) => error.code === 'FS_NOT_FOUND',
    )
  })

  await check('reports FS_NOT_REGULAR_FILE when reading a directory', async () => {
    const target_ = await fs.resolve(`${workDir}/listing/subdir`)
    await assert.rejects(
      () => fs.readText(target_),
      (error) => error.code === 'FS_NOT_REGULAR_FILE',
    )
  })

  await check('reports FS_NOT_DIRECTORY when listing a file', async () => {
    const target_ = await fs.resolve(`${workDir}/listing/a.txt`)
    await assert.rejects(
      () => fs.listDir(target_),
      (error) => error.code === 'FS_NOT_DIRECTORY',
    )
  })

  await check('reports FS_NOT_TEXT for binary content', async () => {
    await runWsl([
      '-d', target.name, '--', 'bash', '-lc',
      `printf 'a\\0b' > '${workDir}/binary.bin'`,
    ])
    const target_ = await fs.resolve(`${workDir}/binary.bin`)
    await assert.rejects(
      () => fs.readText(target_),
      (error) => error.code === 'FS_NOT_TEXT',
    )
  })

  await check('reads binary bytes when text decoding is not requested', async () => {
    const target_ = await fs.resolve(`${workDir}/binary.bin`)
    const bytes = await fs.readBytes(target_, undefined, 1024)
    assert.equal(bytes.length, 3)
    assert.equal(bytes[1], 0, 'the NUL survived a raw read')
  })

  await check('reports FS_TOO_LARGE rather than truncating', async () => {
    const target_ = await fs.resolve(`${workDir}/big.bin`)
    await runWsl([
      '-d', target.name, '--', 'bash', '-lc',
      `head -c 4096 /dev/zero > '${workDir}/big.bin'`,
    ])
    await assert.rejects(
      () => fs.readBytes(target_, undefined, 100),
      (error) => error.code === 'FS_TOO_LARGE',
    )
  })

  await check('reads a byte window without the whole file', async () => {
    const target_ = await fs.resolve(`${workDir}/window.txt`)
    await fs.writeText(target_, '0123456789')
    const bytes = await fs.readByteRange(target_, { offset: 3, length: 4 })
    assert.equal(Buffer.from(bytes).toString('utf8'), '3456')
    const past = await fs.readByteRange(target_, { offset: 100, length: 4 })
    assert.equal(past.length, 0, 'a window past EOF is empty, not an error')
  })

  await check('streams text in bounded windows that reassemble exactly', async () => {
    const target_ = await fs.resolve(`${workDir}/stream.txt`)
    // Comfortably larger than one window so multiple round trips happen.
    const content = 'abcdefghij'.repeat(60000)
    await fs.writeText(target_, content)
    let assembled = ''
    for await (const chunk of await fs.streamText(target_)) assembled += chunk
    assert.equal(assembled.length, content.length)
    assert.equal(assembled, content)
  })

  await check('lstat reports a symlink without following it', async () => {
    await fs.writeText(await fs.resolve(`${workDir}/sym-target.txt`), 'target')
    await runWsl([
      '-d', target.name, '--', 'bash', '-lc',
      `ln -sf '${workDir}/sym-target.txt' '${workDir}/link.txt'`,
    ])
    const linkInfo = await fs.lstat(`${workDir}/link.txt`)
    assert.equal(linkInfo.type, 'symlink', 'lstat does not follow the final component')
    const followed = await fs.stat(await fs.resolve(`${workDir}/link.txt`))
    assert.equal(followed.type, 'file', 'resolve follows the link to its target identity')
  })

  await check('contains() answers canonical containment', async () => {
    const parent = await fs.resolve(workDir)
    const child = await fs.resolve(`${workDir}/a.txt`)
    const outside = await fs.resolve('/tmp')
    assert.equal(fs.contains(parent, child), true)
    assert.equal(fs.contains(parent, outside), false)
    assert.equal(fs.contains(parent, parent), true)
  })

  await check('processPath returns a Linux path a subprocess can open', async () => {
    const target_ = await fs.resolve(`${workDir}/listing/a.txt`)
    const processPath = fs.processPath(target_)
    assert.equal(processPath, `${workDir}/listing/a.txt`)
    const read = await runWsl(['-d', target.name, '--', 'bash', '-lc', `cat '${processPath}'`])
    assert.equal(read.stdout.toString('utf8'), 'a')
  })

  await check('processPathFromHostPath maps a Windows path into the execution world', () => {
    assert.equal(fs.processPathFromHostPath('D:\\workspace\\x'), '/mnt/d/workspace/x')
    assert.equal(fs.processPathFromHostPath('relative'), undefined)
  })

  await check('fileUrl is an execution coordinate in the Linux namespace', async () => {
    const target_ = await fs.resolve(`${workDir}/a.txt`)
    assert.equal(fs.fileUrl(target_), `file://${workDir}/a.txt`)
  })

  await check('hostPath maps back to a Windows path for host-side UI', async () => {
    const target_ = await fs.resolve(`${workDir}/a.txt`)
    const hostPath = fs.hostPath(target_)
    assert.ok(hostPath.startsWith('\\\\wsl$\\'), `native storage yields a UNC path (got ${hostPath})`)
  })

  await check('flags native storage as NOT Windows-backed', async () => {
    const target_ = await fs.resolve(`${workDir}/a.txt`)
    assert.equal(fs.isWindowsBacked(target_), false)
  })

  await check('flags a /mnt workspace as Windows-backed', async () => {
    const target_ = await fs.resolve('/mnt/d/workspace')
    assert.equal(fs.isWindowsBacked(target_), true, 'drvfs paths must be flagged for callers')
  })

  await check('cwd-relative paths resolve against the configured base', async () => {
    const relative = await fs.resolve('a.txt', { cwd: workDir })
    assert.equal(relative.targetKey, `${workDir}/a.txt`)
  })

  await check('resolves a Windows path supplied by the host', async () => {
    // The workspace really is a /mnt path on this machine, so this must round-trip.
    const viaWindows = await fs.resolve('D:\\workspace\\dsh\\dsh-wsl\\PLAN.md')
    assert.equal(viaWindows.targetKey, '/mnt/d/workspace/dsh/dsh-wsl/PLAN.md')
    const text = await fs.readText(viaWindows)
    assert.match(text, /dsh-wsl/, 'the file read back is the real one')
  })

  await check('walks a tree recursively, bounded, skipping hidden entries', async () => {
    await runWsl([
      '-d', target.name, '--', 'bash', '-lc',
      `mkdir -p '${workDir}/deep/a' && printf x > '${workDir}/deep/a/leaf.txt' && printf y > '${workDir}/deep/top.txt'`,
    ])
    const result = await fs.walkFiles(await fs.resolve(`${workDir}/deep`))
    const names = result.files.map((file) => file.path.replace(`${workDir}/deep/`, ''))
    assert.ok(names.includes('top.txt'))
    assert.ok(names.includes('a/leaf.txt'))
  })

  await check('refuses a Windows path with no WSL mapping', async () => {
    await assert.rejects(
      () => fs.resolve('C:relative\\path'),
      (error) => /cannot map the Windows path/.test(error.message),
    )
  })

  await check('watch() is unsupported and says so rather than polling', async () => {
    const target_ = await fs.resolve(`${workDir}/a.txt`)
    assert.equal(typeof fs.watch, 'function', 'the base class supplies the rejection')
    await assert.rejects(() => fs.watch(target_, () => {}, new AbortController().signal))
  })

  await check('concurrent guarded writes serialize: one wins, the other goes stale', async () => {
    const target_ = await fs.resolve(`${workDir}/race.txt`)
    const created = await fs.writeText(target_, 'base')
    const results = await Promise.allSettled([
      fs.writeText(target_, 'A', { kind: 'replaceIfVersion', version: created.version }),
      fs.writeText(target_, 'B', { kind: 'replaceIfVersion', version: created.version }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'exactly one guarded write won')
    assert.equal(rejected.length, 1, 'the other was rejected')
    assert.equal(rejected[0].reason.code, 'FS_STALE_VERSION')
  })
} catch (error) {
  failures++
  console.log(`\nintegration aborted: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    if (workDir && connection && !connection.closed) {
      await runWsl(['-d', DISTRO, '--', 'bash', '-lc', `rm -rf '${workDir}'`])
    }
  } catch {
    /* best-effort cleanup */
  }
  try {
    await fs?.dispose()
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
