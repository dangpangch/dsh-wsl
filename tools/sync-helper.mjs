/**
 * Sync the helper's protocol module from the authoritative copy.
 *
 * The host imports `packages/dsh-wsl/lib/protocol.js`; the helper is deployed as
 * loose files and imports its own `./protocol.js` beside it. Both must be byte
 * identical or the two halves would disagree about framing, so the helper copy is
 * generated here and `tests/m1-acceptance.mjs` fails if it drifts.
 *
 * Run: node tools/sync-helper.mjs [--check]
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.join(HERE, '..', 'packages', 'dsh-wsl', 'lib', 'protocol.js')
const TARGET = path.join(HERE, '..', 'packages', 'dsh-wsl', 'helper', 'protocol.js')

const checkOnly = process.argv.includes('--check')

const source = await readFile(SOURCE, 'utf8')
const banner = `// GENERATED — do not edit.\n// Authoritative source: packages/dsh-wsl/lib/protocol.js\n// Refresh with: node tools/sync-helper.mjs\n`
const expected = banner + source

let current
try {
  current = await readFile(TARGET, 'utf8')
} catch {
  current = undefined
}

if (current === expected) {
  console.log('helper protocol module is in sync')
  process.exit(0)
}

if (checkOnly) {
  console.error('helper protocol module has DRIFTED from packages/dsh-wsl/lib/protocol.js')
  console.error('run: node tools/sync-helper.mjs')
  process.exit(1)
}

await writeFile(TARGET, expected)
console.log(`synced ${path.relative(path.join(HERE, '..'), TARGET)}`)
