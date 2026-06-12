# AGENTS.md

How agents should work in this repo. Pairs with [CLAUDE.md](CLAUDE.md)
(architecture, stack, run/build) and [NOTES.md](NOTES.md) (the data format).
Read both before making changes.

## Setup

```bash
npm install
```

**If the app won't launch with `Error: Electron uninstall`** (electron-vite can't
find the binary): Electron's post-install didn't extract `electron.exe`. Verify
with `node_modules/electron/path.txt` — if it's missing, the binary isn't
installed. Fix:

```bash
node node_modules/electron/install.js   # usually re-extracts from the @electron/get cache
```

If that still leaves `path.txt` missing (a partial `dist/` can block extraction),
extract the cached zip manually. The zip lives at
`%LOCALAPPDATA%\electron\Cache\<hash>\electron-v<version>-win32-x64.zip`:

```powershell
$root = "$PWD\node_modules\electron"
Remove-Item -Recurse -Force "$root\dist" -ErrorAction SilentlyContinue
Expand-Archive -Path <path-to-cached-zip> -DestinationPath "$root\dist" -Force
"electron.exe" | Out-File "$root\path.txt" -Encoding ascii -NoNewline
```

## Build / test / lint / typecheck

```bash
npm run dev        # dev with HMR (auto-loads sample footage)
npm run typecheck  # MUST pass — tsc for node + web projects
npm run lint       # MUST pass — eslint flat config (eslint.config.mjs)
npm run test       # MUST pass — vitest suite (src/**/*.test.ts)
npm run build      # MUST pass — bundles to out/
npm run preview    # run the production build
npm run build:win  # NSIS installer -> releases/ (config: electron-builder.yml)
```

Packaging note: `electron-builder.yml` whitelists `out/**` + `package.json` on
purpose — never widen `files` in a way that could sweep in the git-ignored
sample footage. After packaging changes, launch `releases\win-unpacked\Tesla
Dash Viewer.exe` once to confirm the production-boot path. If `build:win` dies
with `EBUSY: resource busy or locked` on the unpacked exe, the shell's sandbox
is blocking electron-builder's exe resource rewrite — re-run it in an
unsandboxed shell (it is not an electron-builder or Defender problem).

## Releases

Releases are GitHub pre-releases on a tag (`vX.Y.Z[-alpha.N]`) matching the
`package.json` version, with the NSIS installer + `.blockmap` attached.
**Every release must also post checksums for each attached file**: a
`checksums.txt` asset with `MD5` and `SHA256` lines per file, and the same
block appended to the release notes under a `## Checksums` heading. Compute
with `Get-FileHash <file> -Algorithm MD5|SHA256`. Note GitHub renames asset
filenames (spaces become dots) — checksum lines must use the *renamed* asset
names (e.g. `Tesla.Dash.Viewer-…-setup.exe`) so testers can verify what they
actually downloaded. Smoke the packaged exe (not just `preview`) before
publishing. First done for `v0.1.0-alpha.1` — use that release as the template.

Unit/integration tests run with vitest (`npm run test`); they cover the pure
logic (scanner grouping, telemetry axis, MP4/Range parsing, SyncEngine decisions)
but NOT real playback. **Verification = `npm run typecheck` + `npm run lint` +
`npm run test` + `npm run build` all clean, then launch and observe.** CI
(`.github/workflows/ci.yml`) runs the same four gates on every PR. For a headless smoke test
(boot + scanner + media load) without watching the window:

```bash
timeout 20 npm run preview > /tmp/smoke.log 2>&1   # exit 124 = ran full 20s = didn't crash
grep -E "\[scan\]|\[camera|did-fail-load|media error" /tmp/smoke.log
```

**Windows-first / PowerShell** (this repo's primary platform — `timeout`/`/tmp`/`grep`
above are mac/Linux): run `preview` in the background, then grep the log. **`preview`
runs the built `out/main/index.js`, so it's the real production-boot path** — use it
to catch boot failures (e.g. a bad dep bump) that `typecheck`/`build` miss.

```powershell
$env:TESLA_CAPTURE = "$PWD\smoke.png"   # main process screenshots the UI ~7s after load
npm run preview *>&1 | Out-File "$PWD\smoke.log"   # run in background; stop it when done
# then inspect:
Select-String -Path smoke.log -Pattern "\[scan\]|did-fail-load|App threw|Error|capture"
Get-Process electron | Stop-Process -Force        # background dev/preview leave orphaned
                                                  # electron + vite watchers — always kill them
```

`TESLA_CAPTURE=<path>` (handled in `src/main/index.ts`) writes a PNG of the rendered
window — the only way to verify visual features (HUD, map) headlessly. Auto-select
loads a max-camera *dashcam* clip, so to shoot a Track/SavedClips view temporarily
force its selection in `App.loadRoot` (revert before commit). Clean up `smoke.*`/
capture PNGs and kill orphaned `electron` processes when finished.

The main process logs a `[scan] … -> N segment group(s), M track session(s)` line
and (in dev) forwards renderer logs as `[renderer] …`. Against the bundled sample
the scan must report **116 segment groups, 2 track sessions, cameras
[front, back, left_repeater, right_repeater]**.

## Code style

- **TypeScript strict**, `noUnusedLocals`/`noUnusedParameters` on. Keep it green.
- Functional React + hooks. No class components.
- Tailwind for styling; reuse the `ink`/`accent` palette from `tailwind.config.js`.
  Avoid inline hex colors.
- Use path aliases `@shared/*` and `@renderer/*`, not long relative paths.
- Comments explain **why** (especially anything touching sync, timestamps, or the
  Tesla format), not what.
- Match the surrounding file's naming and structure.

## Process boundaries (important)

- `src/main` and `src/preload` run in **Node/Electron**. `src/renderer` runs in
  the browser context. **Never import `electron` or Node built-ins (`fs`,
  `path`, …) from renderer code** — go through `window.teslaApi` (preload) and
  add an IPC handler in `src/main/index.ts` if you need new capability.
- Shared types go in `src/shared` and are imported by all three.

## Directory map

See [CLAUDE.md](CLAUDE.md) → Directory map. The data model lives in
`src/shared/types.ts`; the format facts behind it are in [NOTES.md](NOTES.md).

## Guardrails

- **Never commit footage.** `TeslaCam/` and `TeslaTrackMode/` (~17GB) are
  git-ignored sample fixtures. Don't `git add -f` them; stage files explicitly
  rather than `git add -A` near these dirs. `node_modules/`, `out/`, `dist*/` are
  also ignored.
- **Never modify or delete the sample footage** — it is read-only test data.
- **Don't hardcode the camera set.** Derive angles from filenames (NOTES.md §3:
  newer cars add `left_pillar`/`right_pillar`; Track Mode is front-only).
- **Don't trust the container frame rate or per-camera durations** for sync —
  drive everything by time / PTS (NOTES.md §4, CLAUDE.md → sync).
- **Branch for changes; open a PR against `main`.** `main` now exists as a base,
  so feature work should land via PR (`git switch -c feat/…`), not direct pushes
  to `main`. Don't push to `main` directly.
- **Don't bump `vite` past `^7`** — and scrutinize dependabot/CI bumps that try.
  `electron-vite@5` + `@vitejs/plugin-react@4.7` don't support rolldown-based
  `vite 8`; it mis-bundles the main process and the app won't boot (dev, preview,
  or packaging). See CLAUDE.md → Known gotchas. After any dependency change, run a
  smoke test (below) — `typecheck`/`build` alone won't catch a broken boot.
- End commit messages with the project's `Co-Authored-By` trailer when committing
  as an agent.
- Keep the **main process thin**; put logic the UI needs behind typed IPC.

## When extending the format support

If you encounter footage that doesn't match NOTES.md (new camera names, a
different `event.json` schema, telemetry `v2`, Cybertruck layout), **update
NOTES.md and `src/shared/types.ts` together**, and prefer dynamic discovery over
new hardcoded assumptions.
