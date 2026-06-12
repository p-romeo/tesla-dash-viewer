# CLAUDE.md

Guidance for Claude (and humans) working in this repo. Read this first, then
[NOTES.md](NOTES.md) for the hard data facts the whole app is built around.
[AGENTS.md](AGENTS.md) has setup, build, and guardrails; read it before making changes.
[README.md](README.md) is the user-facing overview — keep it in sync when features change.

## What this is

**Tesla Dash Viewer** — a desktop app that plays back footage from a Tesla's
USB drive: dashcam/Sentry clips (multiple synchronized camera angles) and Track
Mode sessions (single camera + rich telemetry). Goals:

- Play all available camera angles at once, kept in **tight time sync** through
  play / pause / scrub / seek.
- A **HUD overlay** on the video.
- A **map** synced to the current playback position.
- Modern, clean, polished UI — visual quality is a first-class requirement.

## The single most important fact

There are **two completely different recording systems** on the drive, and they
drive almost every design decision. See [NOTES.md](NOTES.md) §1 and §7.

| | TeslaCam (dashcam/Sentry) | Track Mode |
|---|---|---|
| Cameras | up to N angles (sample: front, back, left/right_repeater) | **1** (front) |
| Clip shape | ~60s segments grouped by start-timestamp | one continuous video |
| Location | coarse pin per SavedClip (`event.json`); **none** for RecentClips | **dense ~45 Hz GPS** in telemetry CSV |
| HUD data | timestamp / event reason only | 29 telemetry channels |

Consequence: the **moving map + rich HUD only fully work in Track Mode**. For
TeslaCam, the map shows at most a single event pin (SavedClips) or nothing
(RecentClips). Don't "fix" this — it's a property of the data.

## Tech stack (locked)

- **Electron** + **React 18** + **TypeScript**, bundled by **electron-vite** (Vite).
  **`vite` is pinned to `^7`** — `electron-vite@5` and `@vitejs/plugin-react@4.7`
  do not support the rolldown-based `vite 8`, which mis-bundles the main process so
  the app won't boot. Don't bump it past 7 (see Known gotchas).
- **Tailwind CSS** for styling (dark, slate-tinted palette in `tailwind.config.js`).
  Surface colors: `ink-{950,900,850,800,700,600}`; accent: `accent` (#3b82f6) / `accent-soft` (#60a5fa).
  Fonts: Inter (sans), JetBrains Mono (mono).
- Map (M5, done): **MapLibre GL** + **OpenStreetMap** raster tiles (free, no API key).
  Corner overlay in `src/renderer/src/components/MapPanel.tsx`. Tiles load through
  the `tiles://` protocol (M8): the main process serves a disk cache
  (`userData/tile-cache`) with network fallback, so the map works offline for
  previously viewed areas (`src/main/tileCache.ts`).
- HUD (M4, done): DOM/SVG overlay (`src/renderer/src/components/Hud.tsx`).
- Platform: **Windows-first, code kept portable** (Mac/Linux are a later build flip).

Why Electron over Tauri/native: Chromium ships identical H.264 decode on all
OSes (Tauri's per-OS webview diverges — Linux WebKitGTK H.264 is patchy), and it
is the fastest path to a polished UI. The one risk — frame-accurate sync of 4
simultaneous streams — is validated by the M1 spike (see below).

## How playback sync works (the core)

`src/renderer/src/sync/SyncEngine.ts` is the heart of the app.

- **Never sync by frame index.** Tesla MP4s report a bogus container frame rate
  (`10000/1`; real ≈36 fps) and each camera's duration differs by ~0.1–0.4s.
  Everything is driven by **time**.
- A **wall-clock master**: `masterTime = anchorMedia + (now - anchorWall) * rate`.
  Robust to any single `<video>` stalling.
- Every animation frame while playing, each video is corrected toward `masterTime`:

  | Drift magnitude | Action |
  |---|---|
  | `> HARD_DRIFT` (0.30s) | Hard re-seek: `video.currentTime = masterTime` |
  | `> SOFT_DRIFT` (0.033s, ~1.2 frames) | Gentle ±`NUDGE` (6%) `playbackRate` trim |
  | else | `playbackRate = rate` exactly |

- **`requestVideoFrameCallback`** measures each camera's *actually-presented*
  frame time (`mediaTime`) — the true on-screen sync metric shown in the
  Diagnostics panel. (Types declared in `src/renderer/src/env.d.ts`.)
- `useSyncEngine.ts` wraps the engine in a React hook, throttling state snapshots
  to **20 Hz** (`UI_HZ`) so React re-renders don't saturate the main thread.
- `NOMINAL_FPS = 36` is used only for `stepFrame()`. Never use it for seek math.
- Supported playback rates: **0.25×, 0.5×, 1×, 2×, 4×** (TransportBar).

### Sync gate

The M1 acceptance criterion: `interCamSpread` (max − min of all cameras'
presented `mediaTime`) stays **< ~2 frames ≈ 56ms** through play, seek, and
scrub. DiagnosticsPanel shows "Locked" when spread ≤ 50ms (a slightly tighter
visual threshold). The self-test (`src/renderer/src/sync/selftest.ts`) measures
this headlessly; see AGENTS.md → Build/test.

### Windows occlusion fix

`src/main/index.ts` appends `--disable-features=CalculateNativeWinOcclusion` at
startup. Without it, Chromium suspends video compositing (and freezes
`requestVideoFrameCallback`) whenever another window overlaps the app. Also,
`BrowserWindow` is created with `backgroundThrottling: false` so the rAF sync
loop keeps running even when the window is not in the foreground.

## Loading local video: the `media://` protocol

The renderer cannot read disk directly. `src/main/index.ts` registers a
privileged **`media://`** scheme whose handler streams the file from disk with
`fs.createReadStream` and **implements HTTP range requests itself** (`206 Partial
Content` + `Accept-Ranges`/`Content-Range`). Range support is required for
seeking: `net.fetch(file://…)` returns a plain `200` with no `Accept-Ranges`, so
`<video>.seekable` stays empty and scrubbing/seeking does nothing — that was a
real bug, don't regress to it. Build URLs with `mediaUrl(absPath)` from
`src/renderer/src/lib/media.ts`: `media://local/<encodeURIComponent(absPath)>`.

The scheme is registered `standard: true`, `secure: true`, `stream: true`,
`supportFetchAPI: true`, `bypassCSP: true`. The `supportFetchAPI` flag also lets
the renderer `fetch()` the Track Mode telemetry CSV over `media://` — no extra
IPC needed.

## IPC surface

All renderer↔main communication goes through `window.teslaApi` (defined in
`src/preload/index.ts`, typed in `src/preload/index.d.ts`).

| Channel (ipcMain.handle) | Method | Description |
|---|---|---|
| `scan-drive` | `scanDrive(root)` | Parse footage root → `ScanResult` |
| `pick-folder` | `pickFolder()` | Native folder picker; returns path or null |
| `get-default-root` | `getDefaultRoot()` | Returns bundled sample root if present |
| — | `selfTest: boolean` | `true` when `TESLA_SELFTEST=1` env var is set |

To add new capability: add an `ipcMain.handle` in `src/main/index.ts`, expose it
in `src/preload/index.ts`, and extend `TeslaApi` in `src/shared/types.ts`.

## Directory map

```
src/
  main/            Electron main process (Node)
    index.ts       app lifecycle, BrowserWindow, media://+tiles:// protocols, IPC wiring
    tileCache.ts   tiles:// logic: OSM tile disk cache with network fallback
    scanner.ts     parse a footage root -> ScanResult (the data model)
    mp4Duration.ts read real clip length from moov/mvhd box (no decode)
  preload/
    index.ts       contextBridge: exposes window.teslaApi (scanDrive/pickFolder/…)
    index.d.ts     window.teslaApi typing for the renderer
  shared/
    types.ts       types shared across main/preload/renderer (SegmentGroup, etc.)
  renderer/
    index.html
    src/
      main.tsx             React root; wraps <App> in the error boundary
      App.tsx              layout, clip selection, keyboard shortcuts
      sync/
        SyncEngine.ts      multi-video sync engine (no React) — the core
        useSyncEngine.ts   React hook; throttles engine snapshots to state @ 20 Hz
        selftest.ts        headless sync measurement (TESLA_SELFTEST=1)
      components/
        VideoGrid.tsx      renders CameraTile grid; registers videos with engine
        TransportBar.tsx   play/pause/seek/scrub/rate controls
        DiagnosticsPanel.tsx  live per-camera spread & drift readout
        ClipBrowser.tsx    left-sidebar clip list (SavedClips / RecentClips / other)
        GalleryView.tsx    full-window thumbnail grid (g key / header button)
        Hud.tsx            DOM/SVG overlay; per-mode (dashcam vs. Track Mode)
        MapPanel.tsx       MapLibre corner mini-map; Track trace+marker / SavedClips pin
        ShortcutsOverlay.tsx  keyboard-shortcut cheatsheet (? key / header button)
        ErrorBoundary.tsx  render-throw fallback (the one sanctioned class component)
      lib/
        media.ts     mediaUrl(), cameraLabel(), orderCameras(), fmtTime(),
                     timeLabel(), clockLabel(), humanizeReason()
        telemetry.ts parseTelemetry(); Telemetry.sampleAt(); buildTimeAxis()
        clipOrder.ts canonical clip ordering, shared by ClipBrowser, GalleryView,
                     and App's prev/next ([/]) navigation so they can't drift apart
      env.d.ts             requestVideoFrameCallback browser type declarations
      styles.css           Tailwind entry + scrubber + no-scrollbar utilities
TeslaCam/  TeslaTrackMode/  ← sample footage (git-ignored, ~17GB; read-only fixtures)
.github/workflows/  ← Claude GitHub Actions (@claude mentions + auto PR review)
NOTES.md   ← data-format findings (source of truth for the format)
AGENTS.md  ← setup, build, guardrails
electron-builder.yml ← packaging config (whitelisted files; NSIS)
build/icon.ico       ← placeholder Windows icon (electron-builder buildResources)
out/       ← build output (git-ignored)
releases/  ← packaged installer output (git-ignored)
```

## Scanner behaviour (`src/main/scanner.ts`)

`scanDrive(root)` accepts three layouts:
1. **Parent dir** containing `TeslaCam/` and/or `TeslaTrackMode/` subdirectories.
2. **TeslaCam dir itself** (contains `RecentClips/`, `SavedClips/`).
3. **Flat segment dir** — if no structured TeslaCam layout is found, the root is
   scanned directly for `YYYY-MM-DD_HH-MM-SS-<camera>.mp4` files.

Segments are laid back-to-back using **measured durations** (`mp4Duration.ts`
reads the `moov/mvhd` box — no decode, no ffprobe). The fallback when a clip
is unreadable is `ASSUMED_CLIP_SECONDS = 60`.

**Gap splitting** (`groupContiguous`, `GAP_THRESHOLD_MS = 60 000 ms`): within
TeslaCam, consecutive clips arrive on a ~71s cadence even for a continuous drive
(Tesla starts a new file before the old one is full), creating a systematic
~6–12s apparent gap that is **not** a real discontinuity. A genuine drive
boundary (car parked/off) is minutes long; only gaps ≥ 60s split into separate
sessions. This threshold was tuned against the sample data — do not lower it
without re-probing the gap distribution.

**Overlap clamping** (M7, `createSessionFromGroups`): when a clip's measured
duration overruns the next clip's start (a start-to-start overlap — rare), its
effective duration is clamped to the wall-clock room before the next start, so
the overlapped footage never plays twice and the per-segment HUD clock never
jumps backwards. The trim is recorded as `SessionSegment.overlapTrimmedSeconds`
and surfaced in the Diagnostics panel. The clamp lives in the shared timeline
builder so it covers SavedClips (which bypass `groupContiguous`) too.

Track Mode video/telemetry pairing: nearest timestamp within a **15-second window**
(laps and telemetry filenames for the same session differ by a few seconds).
`event.mp4` (low-res preview) is deliberately skipped during scanning.

## Telemetry time-axis (`src/renderer/src/lib/telemetry.ts`)

Tesla's `Elapsed Time (ms)` column resets each lap and is **0 throughout the
timer-less warm-up lap** (lap 0), which can be ~45% of the rows. Uniform
row-index mapping compresses the warm-up and bows mid-lap timing by several
seconds vs the video.

`buildTimeAxis` uses a **lap-aware approach** instead:
1. Each timed lap (lap ≥ 1) is anchored by its own `Elapsed Time` — its final
   row's elapsed value equals its duration, so the lap's rows are placed exactly.
2. Timer-less rows (lap 0 / free-roam) share the remaining clip time uniformly.

`sampleAt(timeSeconds, durationSeconds)` does a binary search on the cached axis.
The axis is built lazily (once per session, keyed on clip duration).

For files with all rows at lap 0 and elapsed 0 (free-roam sessions, no timed
laps) the method degrades to uniform row-index mapping — same as before for those
files.

**Telemetry lead-in offset** (fixed in PR #21): Tesla starts the telemetry CSV a
few seconds **before** the laps video (per the filename stamps: 2s and 7s in the
sample sessions), so telemetry row 0 is *not* video time 0. The scanner carries
the CSV's start epoch (`TrackSession.telemetryStartEpochMs`); `App.tsx` computes
`FootageSession.telemetryLeadInSeconds = (videoStart − telemetryStart) / 1000`;
and the HUD and MapPanel both sample at `masterTime + (telemetryLeadInSeconds ?? 0)`.
Both fields are optional: when `telemetryStartEpochMs` is unset (no CSV paired),
the lead-in falls back to 0 — no shift. Any new consumer of `sampleAt()` must
apply the same shift or its stats will lag the footage.

## HUD overlay (`src/renderer/src/components/Hud.tsx`)

The HUD is a `pointer-events-none` absolute overlay that sits on top of the
video grid. It is toggled by the header **HUD** button and the `h` key
(default: on). It reads only the **20 Hz snapshot** — never touches the sync loop.

Two render paths based on `session.kind`:

| Mode | Content |
|---|---|
| `'track'` | Speed (mph, large), Throttle/Brake bars, Steering/G/Power/SoC/Lap grid, wall-clock |
| dashcam (default) | Wall-clock derived per active segment; event reason + city for SavedClips |

**Per-segment wall-clock** is important: `frameEpochMs = segment.group.startEpochMs + (masterTime - segment.offsetSeconds) * 1000`. Using the segment's own start epoch keeps the clock correct across gap-split sessions (a session-wide offset would drift after a gap).

Brake is a pressure channel (bar), not 0–100%. The HUD bar normalizes against
`telemetry.maxBrakeBar` (peak of the session) so the visual scale stays sane.

## Run & build

```bash
npm install        # see AGENTS.md if Electron's binary fails to download
npm run dev        # launch app with HMR (auto-loads the sample footage)
npm run typecheck  # tsc for node (main/preload/shared) + web (renderer) — must pass
npm run lint       # eslint flat config (eslint.config.mjs) — must pass
npm run test       # vitest unit/integration suite (src/**/*.test.ts) — must pass
npm run build      # bundle main + preload + renderer into out/ — must pass
npm run preview    # run the production build locally
npm run build:win  # package a Windows installer (electron-builder) into releases/
```

Packaging is configured in `electron-builder.yml`. Its `files` list is a
**whitelist** (`out/**` + `package.json`) so the ~17GB git-ignored sample
footage can never be swept into a package; `node_modules` is excluded because
every npm dep is vite-bundled into `out/` (main/preload import only `electron` +
Node built-ins). The Windows icon is the placeholder `build/icon.ico`.

Unit tests run with **vitest** (`npm run test`; config in `vitest.config.ts`,
tests live next to their modules as `src/**/*.test.ts`). They cover the pure
logic: telemetry parsing/time-axis, scanner grouping (plus `scanDrive` against
temp-dir fixtures), MP4 duration parsing, `media://` Range parsing
(`src/main/httpRange.ts`), SyncEngine decision logic (stubbed videos/rAF), and
the lib formatters. Playback sync itself is still verified by the headless
self-test + by-eye Diagnostics (see above). Linting (M7) is eslint flat config
(`eslint.config.mjs`): `@eslint/js` + `typescript-eslint` recommended, plus
`eslint-plugin-react-hooks` (the v7 compiler-powered preset) scoped to renderer
code. `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build`
are the gates — all must pass.

CI (`.github/workflows/`): `ci.yml` (M7) runs all four gates — typecheck, lint,
test, build — on every PR and push to `main` (Electron's binary download is
skipped; no gate needs it). `claude-code-review.yml` (PR #24) runs an automatic
Claude code review on every PR; `claude.yml` responds to `@claude` mentions in
issues and PR comments.

`npm run dev` auto-loads the bundled `TeslaCam/`/`TeslaTrackMode/` sample footage
if present (the main process resolves the default root via `get-default-root`).
Use **Open footage folder…** to point at any TeslaCam folder.

Keyboard: `Space` play/pause · `←/→` ±5s (`Shift` = ±1s) · `,`/`.` frame step ·
`[`/`]` prev/next clip · `g` toggle gallery · `h` toggle HUD · `m` toggle map ·
`d` toggle Diagnostics · `?` shortcut overlay.

Headless self-test:
```bash
TESLA_SELFTEST=1 npm run preview
# Prints measured interCamSpread over play + seek. Gate: worst < 56ms -> PASS.
# NOTE: only trustworthy with a visible, foreground window — a backgrounded
# window throttles the rAF correction loop and inflates the worst-case spread.
# Does NOT cover interactive scrub; confirm that by eye in the Diagnostics panel.
```

## Conventions

- **Strict TypeScript**, `noUnusedLocals`/`noUnusedParameters` on. Types shared
  across processes live in `src/shared`; never import `electron` or Node built-ins
  from renderer code — go through `window.teslaApi`.
- Path aliases: `@shared/*` and `@renderer/*` (configured in `electron.vite.config.ts`
  and both `tsconfig.*.json`).
- Functional React + hooks; no class components.
- Tailwind only; reuse the `ink`/`accent` palette. Avoid inline hex colors.
- Keep the **main process thin**: filesystem/OS work and IPC only. All UI is in
  the renderer.
- Discover camera angles **dynamically** from filenames (`CAMERA_ORDER` in
  `src/shared/types.ts` lists `front`, `back`, `left_repeater`, `right_repeater`,
  `left_pillar`, `right_pillar` — a display-ordering hint only). Never hardcode
  "4 cameras"; newer Tesla vehicles add pillar cameras.
- Comments explain **why** (hidden constraint, sync gotcha, Tesla format quirk),
  not what. No multi-line docblocks.

## Milestone status

Last verified: 2026-06-10 (fresh `npm install` + typecheck + build pass at HEAD).
By-eye verification 2026-06-09: M5 map confirmed on a Track session in the
`preview` build — tiles, trace, and a playback-synced marker; scanner grouping
verified against the sample drive by probe + by-eye. Note: the
app only boots after the `vite ^7` pin (see M5) — `vite 8` from PR #15 breaks the
build with the pinned `electron-vite`/`plugin-react`. Post-M5 fix (PR #21):
Track Mode HUD/map now offset telemetry sampling by the CSV-vs-video lead-in
(see "Telemetry time-axis" above).

- [x] **M0** — scaffold (Electron+Vite+React+TS), drive scanner, `.gitignore`, docs.
- [x] **M1** — multi-camera sync. Builds and boots clean; scans the sample; all 4
      cameras stream via `media://` and decode in tight sync. The **sync gate** —
      inter-cam spread < ~2 frames (≈56ms) — is **confirmed by-eye in a foreground
      Diagnostics pass: "Locked" holds through play, seek, and scrub** (2026-06-07).
      Headless self-test corroborates (avg ~30ms; worst-case transients straddle
      the line but settle, and headless inflates drift via rAF throttling).
- [x] **M2** — library/import view (completed 2026-06-08). **Done:** (1) clip
      thumbnails — each sidebar entry shows the `thumb.png` Tesla writes to the
      drive (per SavedClips event, per Track video; the shared folder-level thumb
      for gap-split Recent/Clips), with a neutral placeholder when absent;
      (2) Track Mode playback — Track sessions are a clickable sidebar list and
      play the single front camera by wrapping the `TrackSession` in a synthetic
      one-segment `FootageSession` (`App.tsx` → `selectTrackSession`) that reuses
      the dashcam playback path. HUD/map remain M4/M5. **Deferred (not required for
      M2):** a dedicated full-window thumbnail gallery view.
- [x] **M3** — player core (completed 2026-06-08). **Done:** (1) measured segment
      durations — `scanner.ts` reads each clip's real length from the MP4 header
      (`mp4Duration.ts`) and lays clips back-to-back by measured length (content-
      only timeline, no dead air); recording **gaps split sessions upstream** in
      the scanner (`groupContiguous`, `GAP_THRESHOLD_MS = 60s`) rather than being
      skipped at runtime; (2) productionize cleanup — Diagnostics **off by default**
      behind a `d`-key + header toggle, per-tile **loading spinner** and **"Clip
      unavailable"** overlay on missing/corrupt clips (engine keeps the playhead
      advancing so other cameras stay in sync). **Deferred (not required for M3):**
      explicit **overlap** handling (start-to-start overlaps truncate silently —
      rare in Tesla data).
- [x] **M4** — HUD overlay (per-mode) (completed 2026-06-08). **Done:** a
      DOM/SVG overlay (`components/Hud.tsx`) layered over the video grid, toggled
      by a header button + `h` key (on by default). **Dashcam/Sentry:** per-frame
      wall-clock (derived per active segment, so it stays correct across gap-split
      sessions) + event reason/city for SavedClips (from the already-parsed
      `event.json`); RecentClips show timestamp only (a property of the data).
      **Track Mode:** speed, throttle/brake, lateral/longitudinal G, steering,
      power, charge, lap, sampled from the telemetry CSV. The renderer telemetry
      parser (`lib/telemetry.ts`) was pulled forward from M5 and streams the CSV
      over `media://` (text/csv + supportFetchAPI) — no new IPC. The HUD reads the
      20 Hz snapshot only; the M1 sync loop is untouched. The telemetry time-axis
      uses a **lap-aware mapping** (`buildTimeAxis`) rather than uniform row-index,
      correctly placing timed laps against the clip while spreading warm-up rows
      proportionally.
- [x] **M5** — MapLibre map (completed 2026-06-09). **Done:** a corner mini-map
      overlay (`components/MapPanel.tsx`) over the video grid, toggled by a header
      **Map** button + `m` key (on by default; the button is disabled for clips with
      no location). MapLibre GL + OpenStreetMap raster tiles — no API key, and a
      raster-only style needs no glyph/sprite server, so markers are plain DOM. Two
      modes from `session.kind`: **Track Mode** draws the full ~45 Hz GPS trace
      (`telemetry.samples` lat/lon) as a line and a marker that follows playback —
      it reuses `telemetry.sampleAt(masterTime, duration)` on the **same lap-aware
      axis as the HUD**, so map and HUD stay in lockstep; **SavedClips** show one
      event pin from `event.json` (`estLat`/`estLon`). **RecentClips carry no
      location** (a property of the data) so the Map toggle is disabled. The map
      reads the 20 Hz snapshot only; the M1 sync loop is untouched. The map instance
      is created once and updated imperatively (trace/marker/bounds), so a 20 Hz
      re-render never rebuilds the WebGL context. **Verified** (2026-06-09): typecheck
      + build clean; booted the production `preview` build by-eye on a Track session —
      OSM tiles load, the 15 235-point trace draws, and the marker tracks playback
      (logged coords advance through the sample route in sync with the HUD). Live
      tiles require network; **offline tile caching is out of scope** (deferred).
      **Toolchain fix bundled here:** PR #15 bumped `vite` to 8 (rolldown-based),
      which `electron-vite@5` + `@vitejs/plugin-react@4.7` don't support — it mangled
      the main-process bundle so the app wouldn't boot at all. Pinned `vite` back to
      `^7.0.0` (the newest both support); a stale local `node_modules` had masked it.
- [x] **M6** — polish, packaging, perf tuning, CSP hardening (completed 2026-06-09).
      **Polish + correctness slice** (PR #22):
      (1) **Track-only folders fixed** — `App.loadRoot` now falls back to the first
      track session when there are no dashcam sessions, and the sidebar renders when
      *either* list is non-empty (was gated on `scan.sessions.length > 0`), so a
      `TeslaTrackMode/`-only root is reachable instead of erroring "No dashcam clips";
      (2) **React error boundary** (`components/ErrorBoundary.tsx`, the one sanctioned
      class component — React 18 has no functional equivalent) wraps `<App>` in
      `main.tsx` so a render throw shows a Reload fallback, not a white screen;
      (3) **keyboard-shortcut overlay** (`components/ShortcutsOverlay.tsx`) toggled by
      `?` and a header button (`Esc`/backdrop dismiss); (4) **a11y** — scrubber
      `aria-label`/`aria-valuetext` and a global `:focus-visible` ring in `styles.css`.
      **Perf:** reviewed and healthy (rAF loop O(cameras), 20 Hz UI throttle,
      `ClipBrowser` memoized) — sidebar virtualization evaluated and **deferred** (not
      needed at ~118 items). **Packaging + CSP slice** (2026-06-09): (5) **production
      CSP** — a strict policy `<meta>` injected into the built `index.html` by the
      build-only `injectCsp` plugin in `electron.vite.config.ts` (dev stays CSP-free
      for react-refresh/HMR; see Known gotchas); (6) **electron-builder config**
      (`electron-builder.yml`) — appId/productName, NSIS target, whitelisted `files`
      (`out/**` + `package.json`, `node_modules` excluded — all deps are vite-bundled)
      so the sample footage can't be packaged, plus a generated placeholder
      `build/icon.ico` (256px embedded-PNG ICO). **Verified** (2026-06-09): typecheck +
      build clean; `preview` smoke under the production CSP on a forced Track session —
      scan reports 116 groups / 2 track sessions and the capture shows video, Track HUD
      telemetry, OSM tiles, and the GPS trace all rendering (tiles + MapLibre blob
      worker + CSV fetch all pass the policy); `npm run build:win` produces the NSIS
      installer and `releases\win-unpacked\Tesla Dash Viewer.exe` boots and scans the
      sample. **Still out of scope:** code signing, auto-update, Mac/Linux targets,
      offline tile caching, a real eslint setup.
- [x] **M7** — dev hygiene & data-model correctness (completed 2026-06-10).
      **Done:** (1) **Real eslint setup** — eslint flat config
      (`eslint.config.mjs`): `@eslint/js` + `typescript-eslint` recommended
      repo-wide, `eslint-plugin-react-hooks` (v7 compiler-powered preset)
      scoped to renderer code; `npm run lint` joined the gates. Fixed what it
      flagged: `useSyncEngine` now creates the engine via lazy `useState`
      (constructing is side-effect free — the rAF loop only starts in the
      effect) instead of a ref read during render; `MapPanel`'s playback
      `position` is memoized on the coordinate primitives so the marker effect
      fires on movement, not on every 20 Hz snapshot; `SyncEngine.toggle` lost
      its expression-statement ternary. One sanctioned disable: App's
      synchronous `setTelemetry(null)` reset-on-session-switch
      (`set-state-in-effect`), which is deliberate stale-data protection.
      (2) **Scanner overlap handling** (deferred from M3) — start-to-start
      overlaps no longer truncate silently: the shared timeline builder
      (`createSessionFromGroups`) clamps a clip's effective duration to the
      wall-clock room before the next clip's start (covers gap-split
      Recent/other *and* SavedClips paths), records the trim as
      `SessionSegment.overlapTrimmedSeconds`, and DiagnosticsPanel shows an
      amber "Segment overlap" card with clip count + seconds trimmed; covered
      by 4 new vitest cases (97 total pass). (3) **CI** — `ci.yml` runs
      typecheck/lint/test/build on every PR and push to `main`.
- [x] **M8** — library & maps UX (the deferred user-facing features).
      (1) **Offline map tile caching** — **done** (2026-06-11): a privileged
      `tiles://` protocol in main (same pattern as `media://`) serves
      `tiles://osm/{z}/{x}/{y}.png` from a disk cache under
      `userData/tile-cache`, falling back to `net.fetch` against
      tile.openstreetmap.org (identifying User-Agent; no prefetch — only tiles
      the map actually requests, per OSM tile-usage policy; cache-first, so a
      viewed area keeps working offline). Logic lives electron-free in
      `src/main/tileCache.ts` (strict z/x/y validation — the coords become a
      filesystem path; atomic write-then-rename) with 12 vitest cases (109
      total pass). `MapPanel` routes the scheme through `maplibregl.addProtocol`
      (MapLibre only fetches non-http schemes via addProtocol) and caps the
      raster source at `maxzoom: 19` (OSM's ceiling). The production CSP now
      lists `tiles:` instead of the OSM origin — the renderer no longer talks
      to any external origin directly. **Verified end-to-end on Windows**
      (2026-06-11): `TESLA_CAPTURE` smoke of the production `preview` build on
      a Track session renders OSM tiles through `tiles://` under the strict
      CSP; the disk cache held only the 8 tiles the map requested (no
      prefetch), and a second run served all of them from disk (file
      timestamps unchanged — zero re-downloads).
      (2) **Full-window thumbnail gallery** (deferred from M2) — **done**
      (2026-06-11): `components/GalleryView.tsx`, a full-window overlay grid of
      the per-event/per-session `thumb.png` (lazy-loaded `<img>` over
      `media://`), toggled by a header **Gallery** button + `g` key, closed by
      `Esc`/`✕`/picking a clip. Sections and ordering come from
      `gallerySections()` in `clipOrder.ts` (footage sections + Track Mode);
      `orderedNavEntries` now flattens it, so gallery, sidebar, and `[`/`]`
      navigation share one canonical order (2 new vitest cases pin the
      equivalence; 112 total pass). Verified by `TESLA_CAPTURE` smoke of the
      production build: all three sections render with thumbs, timestamps,
      durations, camera chips, and event reasons.
- [~] **M9** — distribution: signed, updatable, cross-platform (only when the app
      ships beyond this machine). (1) **Code signing** — moved to M10 (4)
      (Azure Trusted Signing). (2) **Auto-update** — electron-updater + GitHub
      Releases; blocked on signing (updates from an unsigned publisher are worse
      than none). (3) **Mac/Linux builds** — "a later build flip" but expect real
      per-OS work: the `CalculateNativeWinOcclusion` flag is Windows-only,
      packaging targets differ, Mac needs notarization (depends on the Apple
      equivalent of (1)); needs hardware to verify. (4) **Electron major upgrade**
      — **done** (2026-06-11): 39.8.10 (EOL) → 42.4.0 (current stable), exact pin
      kept (see Known gotchas). All four gates pass; verified by a `TESLA_CAPTURE`
      smoke of the production `preview` build on a forced Track session with the
      tile cache cleared first — video decodes, the telemetry HUD renders (the
      `media://` CSV fetch works), and the map redownloads exactly the 8 requested
      OSM tiles through `tiles://` (both schemes' `corsEnabled` registration
      carries over; no `Failed to fetch`/CORS lines after `[scan]`).

- [~] **M10** — public launch (free, open source; decided 2026-06-11 after the
      v0.1.0-alpha.1 closed alpha). Sell-it-later stays open; free-first builds
      users and feedback. (1) **GPL-3.0 license** — done: LICENSE file,
      `package.json` `GPL-3.0-only`, README updated (README previously claimed
      MIT with no LICENSE file; sole-author relicense, nothing was distributed
      under it). (2) **History/privacy audit** — done, two findings: NOTES.md
      carries real ~10 m-precision GPS coords + NJ town names from the sample
      drive in every historical version, and some commits carry a personal
      email. Resolution pending (likely: redact NOTES.md and publish with fresh
      history). (3) **Issue templates** — done (bug report asks for clip folder
      name + app version; feature request flags data-limit asks). (4) **Code
      signing** — deferred past launch (decided 2026-06-11): ship unsigned with
      checksums + a README SmartScreen note. Free path queued: **SignPath
      Foundation** (free signing for OSI-licensed OSS — GPL ✓; note the cert
      is issued to the Foundation, so *they* appear as publisher) needs the
      project public + released + a CI release pipeline, so it can't cover
      launch day; build the pipeline post-launch and apply. Paid fallback:
      **Azure Artifact Signing** (Trusted Signing was renamed, not retired;
      US/Canada individuals eligible, Basic $9.99/mo). Self-signing does NOT
      help — SmartScreen only trusts CA-chained certs. Subsumes M9 (1). (5) **OSM tile
      policy** — resolved (2026-06-11): the policy explicitly *allows*
      distributed apps given a distinct UA with contact info, local caching,
      and no bulk/pre-emptive downloading — the M8 tile cache already complies
      by design; added the repo URL to the tile User-Agent to complete it.
      Revisit (MapTiler/Stadia key) only if OSM ever blocks or rate-limits us. (6) **Flip
      public + launch post** (Reddit) — gated on (2), strongly helped by (4).
- [ ] **M11** — HW4 camera support: pillar cameras + the bumper camera from
      the newer recording system. **Blocked on sample footage** from a HW4
      vehicle (none available as of 2026-06-11) — do not guess formats.
      Current readiness: pillars are already first-class (`CAMERA_ORDER`,
      labels, ordering tests); an unknown bumper token will still be
      discovered/played/synced (dynamic discovery) but sorts after known
      cameras with a generic label — adding it to `CAMERA_ORDER` +
      `cameraLabel()` is a two-line fix once the real filename token is known.
      To verify against real footage: (1) the bumper filename token;
      (2) resolution/codec — if HW4 records HEVC, decode support and sync
      perf need re-validation; (3) any folder-layout changes; (4) the sync
      gate (< ~2 frames spread) with up to 7 simultaneous streams — re-run
      the M1-style by-eye Diagnostics pass and headless self-test; (5) grid
      layout/UX at 5–7 tiles.

Not scheduled: **sidebar virtualization** — evaluated and rejected in M6 at ~118
items; revisit only if a real drive scan makes the sidebar lag (roughly >500–1000
items). A tripwire, not a milestone.

Legend: `[x]` done · `[~]` partial · `[ ]` not started.

## Known gotchas

- **Don't upgrade `vite` past `^7`.** `electron-vite@5` + `@vitejs/plugin-react@4.7`
  top out at vite 7; the rolldown-based `vite 8` inlines the npm `electron` shim into
  the main bundle, so `getElectronPath()` throws and the app won't launch in **dev,
  preview, or packaging**. A dependabot bump (PR #15) caused exactly this — a stale
  `node_modules` masked it until a fresh install exposed it (fixed by re-pinning to
  `^7` in PR #18). Reject vite-8 dep bumps until electron-vite + plugin-react support
  it. Symptom: `Error: Electron failed to install correctly …` thrown from inside
  `out/main/index.mjs` (not the binary-extraction case below).
- **`electron` is pinned exactly (`42.4.0`, no `^`).** Since Electron 39.8.10's
  security fix (electron#51272), cross-origin `fetch()`/XHR to custom protocols
  is blocked unless the scheme is registered with `corsEnabled: true` — without
  it, map tiles (`tiles://`) and the telemetry CSV (`media://`) silently stop
  loading in production (the renderer origin is `file://`). Both schemes set
  `corsEnabled` in `src/main/index.ts`; keep it on any new scheme. The exact pin
  exists because a caret-range drift (39.8.5 → 39.8.10) regressed the map with
  no code change. Bump deliberately and re-run a preview smoke (watch for
  `Failed to fetch` / CORS lines after `[scan]`). Upgraded 39.8.10 → 42.4.0 on
  2026-06-11 (M9 (4)); the same smoke passed unchanged.
- **Electron binary download** sometimes doesn't extract on `npm install` (no
  `node_modules/electron/path.txt`). It can also fail **silently** — `install.js`
  exits 0 having extracted only `dist/locales`. Fix in AGENTS.md → Setup.
- A dev-only **CSP warning** is expected and harmless. Production builds get a
  strict CSP `<meta>` injected at **build time only** (the `injectCsp` plugin in
  `electron.vite.config.ts`) — dev must stay CSP-free because the react-refresh
  preamble is an inline script and HMR needs a websocket. If a new external
  origin or capability is added (fonts, APIs, workers), extend the `CSP` string
  there or the feature will silently fail **only in production**.
- No audio in any Tesla footage — videos are always muted (also required for
  programmatic `play()`).
- **`requestVideoFrameCallback` freezes when the window is occluded or hidden.**
  The Windows occlusion fix handles the common case, but the self-test results
  are only trustworthy with the app window visible and focused.
- Tesla `event.mp4` (10s, 6fps, MPEG-4 Part 2, 640×480) is a preview only —
  ignored for playback, reserved for thumbnails in M2.
- Segment durations within one group differ by ~0.1–0.4s; the shortest camera
  "ends" first and holds its last frame while the master clock advances past it.
- **Telemetry starts before the video**: the Track Mode CSV begins a few seconds
  before the laps video. Sample telemetry at `masterTime +
  session.telemetryLeadInSeconds`, never raw `masterTime` (see "Telemetry
  time-axis").
- **Telemetry BOM**: some Tesla CSVs carry a UTF-8 BOM (`0xFEFF`) before the
  header. `parseTelemetry` strips it — without this, the `Lap` column name fails
  its lookup and the entire lap field silently reads 0 all session.
- **Track Mode telemetry-only files**: the sample contains two CSVs with no
  matching video (`2025-12-20`). The scanner skips them (no `laps-*.mp4` within
  the 15s pairing window). These are valid recordings (free-roam, all lap 0).
