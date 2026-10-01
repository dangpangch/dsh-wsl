/**
 * Run every acceptance file in order, stopping at the first failure.
 *
 * `node --test tests/` cannot collect these: Node v24 treats the positional argument
 * as a glob pattern and the files do not match the default test-name patterns
 * (PLAN §4.6.6). The acceptance files also target a real distribution and are meant
 * to run sequentially, so an explicit runner is the honest shape.
 *
 * @module tools/run-acceptance
 */
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const testsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests')
const files = (await readdir(testsDir)).filter((name) => name.endsWith('-acceptance.mjs')).sort()

if (files.length === 0) {
  console.error(`no acceptance files found in ${testsDir}`)
  process.exit(1)
}

for (const file of files) {
  console.log(`=== ${file} ===`)
  const result = spawnSync(process.execPath, [path.join(testsDir, file)], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`${file} failed`)
    process.exit(result.status ?? 1)
  }
}

console.log(`${files.length} acceptance files passed`)
