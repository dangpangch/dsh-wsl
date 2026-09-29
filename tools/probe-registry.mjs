'use strict';
// Probe the npm registry for the @deepseek-ai DSH seam packages we need as peers.
const names = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-ssh',
  '@deepseek-ai/dsh-fs-ssh',
  '@deepseek-ai/dsh-subprocess-ssh',
  '@deepseek-ai/dsh-sandbox-ssh',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-api-workspace-controller',
];

const WANT = '0.2.0-rc.2';

(async () => {
  for (const name of names) {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
    try {
      const res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
      if (!res.ok) {
        console.log(`${res.status}\t${name}`);
        continue;
      }
      const doc = await res.json();
      const versions = Object.keys(doc.versions || {});
      const has = versions.includes(WANT);
      const chosen = has ? WANT : (doc['dist-tags']?.next ?? doc['dist-tags']?.latest);
      const meta = doc.versions?.[chosen];
      console.log(
        `OK\t${name}\thasExact=${has}\tchosen=${chosen}\tpeerDeps=${JSON.stringify(meta?.peerDependencies ?? {})}\tdeps=${JSON.stringify(meta?.dependencies ?? {})}`,
      );
    } catch (e) {
      console.log(`ERR\t${name}\t${e.message}`);
    }
  }
})();
