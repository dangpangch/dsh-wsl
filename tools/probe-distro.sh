#!/usr/bin/env bash
# M1 provisioning probe: what tools and network does the distribution actually have?
set -u

echo "--- uname ---"
uname -m

echo "--- tools ---"
for t in curl wget tar xz unxz zstd sha256sum openssl bash; do
  if command -v "$t" >/dev/null 2>&1; then
    echo "$t=OK:$(command -v "$t")"
  else
    echo "$t=MISSING"
  fi
done

echo "--- local node candidates ---"
for c in /usr/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME/.local/share/dsh-wsl/debian/node/bin/node"; do
  if [ -x "$c" ]; then echo "NODE:$c"; else echo "no:$c"; fi
done

echo "--- network (5s each) ---"
if command -v curl >/dev/null 2>&1; then
  curl -sS -m 5 -o /dev/null -w "nodejs.org=%{http_code}\n" https://nodejs.org/dist/index.json || echo "nodejs.org=FAIL"
  curl -sS -m 5 -o /dev/null -w "npmjs=%{http_code}\n" https://registry.npmjs.org/ || echo "npmjs=FAIL"
else
  echo "curl unavailable; skipping network check"
fi

echo "--- can we write our private dir? ---"
target="$HOME/.local/share/dsh-wsl"
mkdir -p "$target" && echo "writable=$target" || echo "NOT_WRITABLE"
df -h "$target" | tail -1
