'use strict';
/**
 * Read-only `app.asar` helper.
 *
 * The packed DSH distribution keeps every package README, type declaration and source slice
 * inside `resources/app.asar`, and no bundled tool can read it: the file tool fails on the
 * 121 MB archive with a BigInt error, and `app.asar.unpacked` holds only native binaries.
 * This script is how the contract recorded in PLAN.md was established, so it stays
 * reproducible rather than becoming an unrepeatable one-off.
 *
 * Usage:
 *   node tools/asar.cjs list <substring>              # find entries by path
 *   node tools/asar.cjs get <path> [path...]          # extract files into the temp dir
 *   node tools/asar.cjs lines <from> <to> <out>       # slice line ranges out of the asar
 *
 * Point it at a non-default installation with `DSH_APP_ASAR=/path/to/app.asar`, and
 * override the extraction directory with `DSH_ASAR_OUT`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Locate the packed archive, preferring an explicit override.
 *
 * @returns {string} absolute path to app.asar
 */
function resolveAsar() {
  if (process.env.DSH_APP_ASAR) return process.env.DSH_APP_ASAR;
  const candidates = [
    'D:\\workspace\\tools\\dsh\\resources\\app.asar',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    path.join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness', 'resources', 'app.asar'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'app.asar not found. Set DSH_APP_ASAR to the archive path, for example\n' +
      '  DSH_APP_ASAR="C:\\path\\to\\DeepSeek Harness\\resources\\app.asar" node tools/asar.cjs list dsh-ssh',
  );
}

const ASAR = resolveAsar();
const cmd = process.argv[2];
const OUT = process.env.DSH_ASAR_OUT ?? path.join(os.tmpdir(), 'dsh-wsl-asar');
fs.mkdirSync(OUT, { recursive: true });

const fh = fs.openSync(ASAR, 'r');

// Pickle framing: four little-endian u32 values, where [1] is the header size. The content
// region begins at 8 + headerSize.
//
// Entry `offset` values in the table of contents are RELATIVE to that region, so the data
// lives at `contentBase + offset`. Both halves of that formula matter: using an absolute
// read, or a base of 16 + headerSize, yields four bytes of plausible-looking garbage —
// which is why `tools/check-asar-format.cjs` measures the base instead of trusting it.
const pre = Buffer.alloc(16);
fs.readSync(fh, pre, 0, 16, 0);
const headerSize = pre.readUInt32LE(4);
const contentBase = 8 + headerSize;

// Trim the ASCII tail so `JSON.parse` sees exactly one value.
const raw = Buffer.alloc(pre.readUInt32LE(8));
fs.readSync(fh, raw, 0, raw.length, 16);
let depth = 0;
let inString = false;
let escaped = false;
let end = -1;
for (let i = 0; i < raw.length; i += 1) {
  const byte = raw[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (byte === 0x5c) escaped = true;
    else if (byte === 0x22) inString = false;
  } else if (byte === 0x22) {
    inString = true;
  } else if (byte === 0x7b || byte === 0x5b) {
    depth += 1;
  } else if (byte === 0x7d || byte === 0x5d) {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
const toc = JSON.parse(raw.subarray(0, end).toString('utf8'));

/** Flatten the directory tree into `{path, offset, size}` entries. */
const files = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const entryPath = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, entryPath);
    else if (child.offset !== undefined) {
      files.push({ path: entryPath, offset: Number(child.offset), size: child.size });
    }
  }
})(toc, '');

if (cmd === 'list') {
  const needle = (process.argv[3] || '').toLowerCase();
  const hits = files.filter((entry) => entry.path.toLowerCase().includes(needle)).map((entry) => entry.path);
  console.log(hits.join('\n'));
  console.log(`[files=${files.length} matches=${hits.length}]`);
} else if (cmd === 'get') {
  // Long file names would overflow a Windows path, so the separators become underscores.
  fs.mkdirSync(path.join(OUT, 'pkg'), { recursive: true });
  for (const wanted of process.argv.slice(3)) {
    const entry = files.find((candidate) => candidate.path === wanted);
    if (!entry) {
      console.log(`MISS ${wanted}`);
      continue;
    }
    const bytes = Buffer.alloc(entry.size);
    // Entries are relative to the content region.
    fs.readSync(fh, bytes, 0, entry.size, contentBase + entry.offset);
    if (process.env.DSH_ASAR_DEBUG) {
      console.error(
        `[debug] path=${entry.path} offset=${entry.offset} size=${entry.size} ` +
          `headerSize=${headerSize} contentBase=${contentBase} ` +
          `first=${JSON.stringify(bytes.toString('utf8', 0, 32))}`,
      );
    }
    const dest = path.join(OUT, 'pkg', wanted.replace(/[\\/]/g, '__'));
    fs.writeFileSync(dest, bytes);
    console.log(`OK ${entry.size} ${dest}`);
  }
} else if (cmd === 'lines') {
  const from = Number(process.argv[3]);
  const to = Number(process.argv[4]);
  const outName = process.argv[5];
  // Slice the whole archive: some docs are embedded rather than being their own entry, so
  // line numbers are archive-global.
  const total = fs.fstatSync(fh).size - contentBase;
  const bytes = Buffer.alloc(total);
  fs.readSync(fh, bytes, 0, total, contentBase);
  const lines = bytes.toString('utf8').split('\n');
  const slice = lines.slice(from - 1, to).join('\n');
  const dest = path.join(OUT, outName);
  fs.writeFileSync(dest, slice, 'utf8');
  console.log(`OK lines ${from}-${to} -> ${dest} (${slice.length} chars)`);
} else {
  console.error('usage: node tools/asar.cjs list <substring> | get <path...> | lines <from> <to> <out>');
  process.exitCode = 2;
}

fs.closeSync(fh);
