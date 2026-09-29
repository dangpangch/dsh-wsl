'use strict';
// Download and extract reference DSH packages from npm into a scratch dir (pinned to the DSH version).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const VERSION = '0.2.0-rc.2';
const OUT = process.argv[2] || 'D:\\workspace\\dsh\\dsh-wsl\\.scratch\\ref';
const packages = process.argv.slice(3);

fs.mkdirSync(OUT, { recursive: true });

/** Minimal tar reader: returns [{name, size, offset}] for regular files. */
function readTar(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156]);
    if (type === '0' || type === '\0') entries.push({ name: full, size, offset: off + 512 });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

(async () => {
  for (const name of packages) {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/-/${name.split('/').pop()}-${VERSION}.tgz`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`${res.status}\t${name}`);
      continue;
    }
    const gz = Buffer.from(await res.arrayBuffer());
    const tar = zlib.gunzipSync(gz);
    const entries = readTar(tar);
    const base = path.join(OUT, name.replace(/[@/]/g, '_'));
    let count = 0;
    for (const e of entries) {
      const rel = e.name.replace(/^package\//, '');
      if (!rel || rel.endsWith('/')) continue;
      const dest = path.join(base, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, tar.subarray(e.offset, e.offset + e.size));
      count++;
    }
    console.log(`OK\t${name}\tfiles=${count}\t->${base}`);
  }
})();
