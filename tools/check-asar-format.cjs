'use strict';
/**
 * Derive the `app.asar` content base empirically.
 *
 * Getting this wrong by a few bytes does not fail loudly — it yields plausible-looking
 * garbage — so the base is measured rather than remembered. The sentinel is searched only
 * AFTER the header, because every path also appears in the header JSON itself.
 *
 *   node tools/check-asar-format.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * @returns {string} absolute path to app.asar
 */
function resolveAsar() {
  if (process.env.DSH_APP_ASAR) return process.env.DSH_APP_ASAR;
  const candidates = [
    'D:\\workspace\\tools\\dsh\\resources\\app.asar',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  ];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  throw new Error('app.asar not found; set DSH_APP_ASAR');
}

const ASAR = resolveAsar();
const fh = fs.openSync(ASAR, 'r');
const size = fs.fstatSync(fh).size;
const pre = Buffer.alloc(16);
fs.readSync(fh, pre, 0, 16, 0);
const u32 = [0, 4, 8, 12].map((offset) => pre.readUInt32LE(offset));
const headerSize = u32[1];
const jsonLength = u32[2];
console.log('pickle u32s       :', JSON.stringify(u32), ' file size:', size);

const raw = Buffer.alloc(jsonLength);
fs.readSync(fh, raw, 0, raw.length, 16);
let depth = 0;
let inString = false;
let escaped = false;
let headerEnd = -1;
for (let i = 0; i < raw.length; i += 1) {
  const byte = raw[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (byte === 0x5c) escaped = true;
    else if (byte === 0x22) inString = false;
  } else if (byte === 0x22) inString = true;
  else if (byte === 0x7b || byte === 0x5b) depth += 1;
  else if (byte === 0x7d || byte === 0x5d) {
    depth -= 1;
    if (depth === 0) {
      headerEnd = i + 1;
      break;
    }
  }
}
console.log('header JSON length:', headerEnd, '(declared', jsonLength, ')');
// Where the header's own bytes end, in absolute terms.
const headerAbsoluteEnd = 16 + headerEnd;
console.log('header ends at    :', headerAbsoluteEnd);
const toc = JSON.parse(raw.subarray(0, headerEnd).toString('utf8'));

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

const wanted = 'dsh/node_modules/@deepseek-ai/dsh-fs/package.json';
const target = files.find((entry) => entry.path === wanted);
if (!target) throw new Error(`${wanted} is not present in this archive`);
console.log('declared offset   :', target.offset, 'size:', target.size);

// The whole file must begin with `{`. Search for that signature from the header end onward,
// bounded to a window around the declared offset so the scan stays cheap.
const windowStart = Math.max(headerAbsoluteEnd, target.offset - 64);
const windowLength = 256;
const window = Buffer.alloc(windowLength);
fs.readSync(fh, window, 0, windowLength, windowStart);

/** Absolute positions where a file could start, given the declared offset. */
for (const candidateBase of [8 + headerSize, 12 + headerSize, 16 + headerSize, 0]) {
  const absolute = candidateBase + target.offset;
  const probe = Buffer.alloc(24);
  if (absolute + probe.length > size) continue;
  fs.readSync(fh, probe, 0, probe.length, absolute);
  const text = probe.toString('utf8');
  console.log(`base ${String(candidateBase).padStart(8)} -> abs ${absolute} -> ${JSON.stringify(text.slice(0, 24))}`);
}

// Ground truth: find the file by its opening bytes within the content region.
const signature = Buffer.from('{\n  "name": "@deepseek-ai/dsh-fs"', 'utf8');
let truth = -1;
for (let position = headerAbsoluteEnd; position < size; position += 4 * 1024 * 1024) {
  const read = Math.min(4 * 1024 * 1024 + signature.length, size - position);
  const hay = Buffer.alloc(read);
  fs.readSync(fh, hay, 0, read, position);
  const index = hay.indexOf(signature);
  if (index >= 0) {
    truth = position + index;
    break;
  }
}
console.log('true file start   :', truth);
if (truth >= 0) {
  console.log('=> content base   :', truth - target.offset);
}
fs.closeSync(fh);
