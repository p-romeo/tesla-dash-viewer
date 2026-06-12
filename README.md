# Tesla Dash Viewer

A free, open-source desktop app for playing back footage from a Tesla's USB
drive — dashcam and Sentry clips (multiple synchronized camera angles) and
Track Mode sessions (single camera with rich telemetry, lap data, and a moving
map).

Built with **Electron + React + TypeScript**, bundled by **electron-vite**.
Licensed under **GPL-3.0**.

## Install (Windows)

1. Grab the latest `Tesla.Dash.Viewer-<version>-setup.exe` from
   [Releases](../../releases).
2. **SmartScreen will warn you** — builds are not code-signed yet (planned).
   Click **More info → Run anyway**. Every release publishes MD5/SHA-256
   checksums (`checksums.txt`) so you can verify your download:
   `Get-FileHash <file> -Algorithm SHA256` in PowerShell.
3. Launch, click **Open footage folder…**, and pick your Tesla USB drive — the
   folder containing `TeslaCam/` and/or `TeslaTrackMode/` (either subfolder
   alone, or even a flat folder of clip files, also works).

### Privacy

Everything runs locally — your footage, telemetry, and event data never leave
your machine. The only network traffic is fetching map tiles for areas you
view (cached on disk afterward, so previously viewed areas work offline).

## Features

- **Multi-camera playback** — plays every available camera angle at once
  (front, rear, repeaters, pillars) kept in tight time sync through play, pause,
  scrub, and seek. Camera angles are discovered dynamically from filenames, so
  newer vehicles with extra cameras work without code changes.
- **HUD overlay** — a per-mode heads-up display over the video:
  - *Dashcam / Sentry:* wall-clock time, plus event reason and city for
    SavedClips.
  - *Track Mode:* speed, throttle/brake, lateral/longitudinal G, steering,
    power, charge, and lap, sampled live from the telemetry CSV.
- **Synced map** — a MapLibre + OpenStreetMap corner mini-map. Track Mode draws
  the full ~45 Hz GPS trace with a marker that follows playback; SavedClips show
  a single event pin.
- **Clip browser** — a sidebar grouped into SavedClips, RecentClips, and Track
  sessions, with thumbnails pulled from the drive.
- **Gallery** — a full-window thumbnail grid of every clip (header button or
  `g`), as an alternative entry point to the sidebar.
- **Diagnostics panel** — live per-camera sync spread and drift readout.

## How it works

Tesla writes two completely different recording systems to the drive, and they
drive nearly every design decision:

| | TeslaCam (dashcam / Sentry) | Track Mode |
|---|---|---|
| Cameras | up to N angles | 1 (front) |
| Clip shape | ~60s segments grouped by start time | one continuous video |
| Location | coarse pin (SavedClips only) | dense ~45 Hz GPS in telemetry CSV |
| HUD data | timestamp / event reason | 29 telemetry channels |

As a result, the moving map and rich HUD only fully apply to Track Mode; for
TeslaCam the map shows at most a single event pin (SavedClips) or nothing
(RecentClips). That's a property of the data, not a limitation of the app.

### Sync

`src/renderer/src/sync/SyncEngine.ts` is the core. It never syncs by frame index
(Tesla MP4s report a bogus container frame rate) — everything is driven by a
**wall-clock master time**, and every animation frame each video is corrected
toward it via re-seek or a gentle `playbackRate` trim. The target: inter-camera
spread stays under ~2 frames (≈56 ms) through play, seek, and scrub.

### Local video

The renderer can't read disk directly, so the main process registers a
privileged `media://` scheme that streams files with full HTTP range-request
support — required for seeking to work in `<video>`.

For deeper architecture notes see [CLAUDE.md](CLAUDE.md), data-format findings in
[NOTES.md](NOTES.md), and setup/guardrails in [AGENTS.md](AGENTS.md).

## Developing

```bash
npm install        # see AGENTS.md if Electron's binary fails to download
npm run dev        # launch with HMR (auto-loads bundled sample footage if present)
```

Use **Open footage folder…** to point at any TeslaCam folder. The scanner
accepts a parent directory containing `TeslaCam/` and/or `TeslaTrackMode/`, the
`TeslaCam/` directory itself, or a flat directory of segment files.

### Scripts

```bash
npm run typecheck  # tsc for main/preload/shared + renderer
npm run lint       # eslint (flat config) over the whole repo
npm run test       # run the unit/integration test suite (vitest)
npm run build      # bundle main + preload + renderer into out/
npm run preview    # run the production build locally
npm run build:win  # package a Windows installer (electron-builder)
```

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` / `→` | seek ±5s (`Shift` = ±1s) |
| `,` / `.` | step one frame |
| `[` / `]` | previous / next clip |
| `g` | toggle clip gallery |
| `h` | toggle HUD |
| `m` | toggle map |
| `d` | toggle Diagnostics |
| `?` | keyboard-shortcut overlay |

## Tech stack

- Electron + React 18 + TypeScript, bundled by electron-vite (Vite).
  `vite` is pinned to `^7` — `electron-vite@5` does not support vite 8.
- Tailwind CSS (dark, slate-tinted palette).
- MapLibre GL + OpenStreetMap raster tiles (no API key). Tiles are cached on
  disk as you view them, so the map works offline for areas you've seen before.

Windows-first, with code kept portable for later Mac/Linux builds.

## Status

Milestones M0–M8 are complete: scaffold, multi-camera sync, library view,
player core, per-mode HUD, the synced MapLibre map, polish/packaging, dev
hygiene/CI, and library & maps UX (offline tile caching + the gallery) —
`npm run build:win` produces an NSIS installer, and production builds ship a
strict Content-Security-Policy. See the milestone table in
[CLAUDE.md](CLAUDE.md) for details.

## Reporting issues

Please [open an issue](../../issues) for clips that won't play, cameras out of
sync, wrong timestamps, or UI glitches — ideally with the affected clip's
folder name (e.g. `2024-06-05_17-03-21`) and your app version.

## License

[GPL-3.0](LICENSE). Free to use, study, modify, and share — derivatives must
remain open source under the same license.
