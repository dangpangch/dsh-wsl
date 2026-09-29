# Creates the dsh-wsl commit history, grouped by milestone.
#
# Commits the working tree only; nothing is pushed. Run from the repo root:
#   pwsh -File tools/make-commits.ps1
#
# Why a script: staging is explicit per commit, so no `git add -A` can sweep in a
# stray artifact, and the grouping stays reviewable instead of being 200 lines of
# shell history. Re-running aborts when the tree is already committed.

$ErrorActionPreference = 'Stop'

function Commit-Group {
  param(
    [Parameter(Mandatory)][string]$Message,
    [Parameter(Mandatory)][string[]]$Paths
  )
  foreach ($p in $Paths) {
    if (-not (Test-Path $p)) { throw "missing path for staging: $p" }
  }
  git add -- $Paths
  if ($LASTEXITCODE -ne 0) { throw "git add failed for: $($Paths -join ', ')" }
  git commit -q -m $Message
  if ($LASTEXITCODE -ne 0) { throw "git commit failed: $Message" }
  Write-Host ("committed: {0}" -f ($Message -split "`n")[0])
}

# ── 1. Repository scaffold and the pinned DSH contract ────────────────────────
Commit-Group -Paths @(
  '.gitignore',
  'PLAN.md',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'packages/dsh-wsl/package.json',
  'packages/dsh-wsl/helper/protocol.js',
  'packages/dsh-wsl/lib/protocol.js',
  'tools/asar.cjs',
  'tools/check-asar-format.cjs',
  'tools/make-commits.ps1'
) -Message @'
Scaffold the workspace and pin the DSH contract this plugin is written against

dsh-wsl connects the DeepSeek Harness to a WSL2 distribution. This is the ground
work: workspace layout, the seam versions, and the frame protocol both halves of
the connection share.

Everything here is pinned to @deepseek-ai/* 0.2.0-rc.2, the version the installed
DSH actually ships, because the seam packages are public on npm but the source
monorepo is not.

Notable constraints recorded while establishing this, since all of them fail
silently when guessed wrong:

- The packed DSH distribution keeps its docs and types inside app.asar, which no
  bundled tool can read (the file tool fails on 121 MB with a BigInt error) and
  whose unpacked half holds only native binaries. tools/asar.cjs is the reader,
  and tools/check-asar-format.cjs measures its framing constants from the archive
  rather than trusting them: entry offsets are relative to a content region at
  8 + headerSize, and both halves of that formula matter.
- The frame protocol is length-prefixed rather than newline-delimited. The
  transport is wsl.exe stdio, which crosses the Windows/Linux boundary, so newline
  translation would corrupt a line protocol and JSON strings could not be carried
  safely without escaping.

The helper's protocol module is a generated copy of the authoritative one in lib/,
because the helper is deployed as loose files rather than installed as a package.
'@

# ── 2. M1: connection skeleton ───────────────────────────────────────────────
Commit-Group -Paths @(
  'packages/dsh-wsl/helper/wsl-helper.mjs',
  'packages/dsh-wsl/lib/runtime.js',
  'packages/dsh-wsl/lib/connection.js',
  'tools/sync-helper.mjs',
  'tools/fetch-ref.mjs',
  'tools/probe-registry.mjs',
  'tools/probe-distro.sh',
  'tests/m1-acceptance.mjs'
) -Message @'
M1: connect to a distribution and verify the helper over wsl.exe

Establishes the transport, the helper lifecycle, and the runtime the helper needs.

Two findings drove the design:

- wsl.exe stdio is a usable long-lived bidirectional channel: ordering is
  preserved, a single write of at least 1 MiB is fine, and WSL_UTF8=1 yields clean
  UTF-8. Its -l -v output still needs dual decoding, because the flag has no effect
  on every build.
- The distribution has no Linux Node at all, and registry.npmjs.org is blocked
  from inside it while nodejs.org is reachable. So the default is to download the
  pinned archive on this machine, verify it against the release's own published
  SHA-256, and unpack it inside the distribution. The distribution then needs no
  egress, which is what makes a locked-down host work; downloading in-distribution
  stays available as a strategy.

The helper is deployed as two loose files and read back with sha256sum before use,
because a host that cannot verify its own deployment cannot trust the digest it
reports to callers. It expires its own lease when heartbeats stop, so a crashed
host still gets its managed ranges torn down.

Verification is 28 checks in tests/m1-acceptance.mjs, including the acceptance
signal itself: uname reports the WSL2 Linux kernel from inside the distribution.
'@

# ── 3. M2: the subprocess provider ───────────────────────────────────────────
Commit-Group -Paths @(
  'packages/dsh-wsl/lib/subprocess.js',
  'tests/m2-acceptance.mjs'
) -Message @'
M2: implement ctx.subprocess against the distribution

Executable lookup, terminalEnvironment, managed spawn with collected output,
batch stdin, termination by process group, and managed-range observation all run
inside the distribution. Executable paths belong to the same execution world as
the filesystem provider, which the seam requires: a path resolveExecutable
returns is a path the filesystem can open.

Two decisions worth stating:

- Raw 'pipe' output streams and the optional duplex control channel are REFUSED
  with a clear error rather than silently degraded. Both need a second independent
  stream channel. A single framed pipe over wsl.exe cannot provide one while
  keeping administrative replies unforgeable; the reference SSH provider gets that
  property from per-stream SSH channels.
- Termination signals the whole process group, so waitForExit observes real
  quiescence rather than only the direct child.

The child environment is scrubbed of credential-shaped names and every DSH_* name,
merging the spec's explicit entries afterwards so a deliberate opt-in still works.

Verification is 17 checks in tests/m2-acceptance.mjs.
'@

# ── 4. M3: the filesystem provider ───────────────────────────────────────────
Commit-Group -Paths @(
  'packages/dsh-wsl/helper/fsio.mjs',
  'packages/dsh-wsl/lib/paths.js',
  'packages/dsh-wsl/lib/fs.js',
  'tests/m3-acceptance.mjs'
) -Message @'
M3: implement ctx.fs against the distribution, with path translation

All file mutation semantics live beside the data in the helper's fsio module and
are only DRIVEN from the host, so there is never a second, subtly different copy of
a mutation rule: realpath identity, atomic publication, per-target serialization,
and literal edits that preserve the file's line-ending style.

Windows-to-Linux path translation is pure, total, and explicitly reports that it
cannot translate rather than guessing, because a mistranslation targets a
different file instead of failing.

A defect the tests caught immediately: the filesystem error codes are outside the
transport's narrow vocabulary, so the first version flattened every domain failure
to INTERNAL and callers could not branch. The helper now forwards the real code out
of band and the host rethrows it.

Watch is deliberately unsupported, matching the reference SSH provider: a polling
watcher would spend a round trip per interval per target on the one control channel
that carries every other operation.

Verification is 52 checks in tests/m3-acceptance.mjs, covering every FS_* code,
CRLF preservation verified with od, and version-guard detection of an equal-size
rewrite.
'@

# ── 5. M5a: whole-profile switch and the installable bundle ──────────────────
Commit-Group -Paths @(
  'packages/dsh-wsl/lib/provider.js',
  'packages/dsh-wsl/index.js',
  'packages/dsh-wsl-bundle',
  'tests/m5a-acceptance.mjs'
) -Message @'
M5a: switch the whole profile to WSL and ship the installable bundle

fs and subprocess are host-plane services: a consumer reaches them by inject,
which resolves during fiber construction before any Session exists. They are
therefore one per composition rather than one per workspace, so enabling WSL means
REPLACING the local providers instead of routing around them. This is a
whole-profile mode, and local and WSL Sessions cannot coexist in one profile.

The bundle patch disables the rows it replaces. That is required rather than
convenient, and it is measured: a second host row cannot take a live service slot
-- Cordis refuses it, the new fiber fails, and the LOCAL provider keeps working.
Without the patch the plugin would appear installed while every consumer silently
continued using the Windows filesystem.

Two defects fixed while wiring this up:

- '~' was joined before it could expand, so it became '/~'. Expansion now happens
  against the base first.
- The relative-path base came from the host cwd, a Windows path. It is now resolved
  from the connection -- the Linux home the distribution reports -- on demand, so
  registering the provider performs no I/O.

Known gap, stated in the patch itself rather than hidden: with sandbox-local and
fs-sandbox disabled, a sandbox mode is reported but not enforced for WSL paths,
because a host-side process fence cannot confine processes inside the
distribution. sandboxPolicy stays mounted for consumers that require it.

Verification is 11 checks in tests/m5a-acceptance.mjs, including the paired
assertion that the providers operate inside the distribution.
'@

# ── 6. Vendored ponytail skills ──────────────────────────────────────────────
Commit-Group -Paths @(
  '.agents/skills',
  'tools/install-skills.mjs'
) -Message @'
Vendor the ponytail skill set and the installer that verifies it

.agents/skills is a DSH skill root, so the skills are usable directly; the DSH
filesystem skill provider had to be enabled for anything on disk to be discovered
at all.

Pinned to upstream commit e3ba2aa and verified per file against the GitHub blob SHA
recomputed from the content, so a moved branch or a tampered mirror cannot silently
change what lands on disk. tools/install-skills.mjs is repeatable and supports
--check.

Only the six portable skills are vendored. The distribution's host-specific
adapters are intentionally not installed, and caveman is NOT included: ponytail's
own portability doc defines the portable set as those six, and caveman appears only
as benchmark data in that repository, so pulling it from a third party would be
introducing untrusted content under a misleading name.

MIT, Copyright (c) 2026 DietrichGebert; LICENSE is carried alongside.
'@

Write-Host ''
Write-Host '--- history ---'
git --no-pager log --oneline
Write-Host ''
Write-Host '--- working tree ---'
git status --short
Write-Host '(nothing above means the tree is fully committed)'
