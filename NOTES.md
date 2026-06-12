# Tesla Footage — Data Exploration Notes

> Derived entirely from the example data placed in this repo (`TeslaCam/` and
> `TeslaTrackMode/`). Nothing here is assumed from prior knowledge of the Tesla
> format — every claim below was verified with `ffprobe`/`ffmpeg` and direct file
> inspection. **Items marked 🚩 are ambiguous and need your confirmation.**

Exploration date: 2026-06-04. Tools: `ffprobe`/`ffmpeg` 8.1.1.

---

## 1. Top-level layout

The drive contains **two independent recording systems** with different formats,
camera counts, and metadata. This distinction drives the whole app design.

```
TeslaCam/                         # Dashcam / Sentry system  (17 GB)
├── RecentClips/                  # rolling buffer, no per-clip metadata
│   ├── 2026-06-04_17-03-32-front.mp4
│   ├── 2026-06-04_17-03-32-back.mp4
│   ├── 2026-06-04_17-03-32-left_repeater.mp4
│   ├── 2026-06-04_17-03-32-right_repeater.mp4
│   ├── ... (54 timestamps × 4 cameras)
│   └── thumb.png                 # single 128×96 preview for the whole folder
└── SavedClips/                   # one folder per saved "event"
    └── 2024-06-04_14-58-41/       # folder name = when the event was saved
        ├── 2024-06-04_14-47-29-front.mp4   (the ~10 min buffer BEFORE the event)
        ├── ...-back.mp4 / -left_repeater.mp4 / -right_repeater.mp4
        ├── event.json            # ← location + event reason (see §5)
        ├── event.mp4             # 10 s low-res single-camera preview (see §4)
        └── thumb.png             # 128×96 preview

TeslaTrackMode/                   # Track Mode telemetry system  (286 MB)
├── laps-2024-06-04-15_34_11.mp4          # ONE continuous video (front cam only)
├── laps-2024-06-04-15_34_11-thumb.png    # 128×96 preview
├── telemetry-v1-2024-06-04-15_34_09.csv  # rich per-sample telemetry + GPS (see §6)
├── laps-2024-06-07-15_25_49.mp4
├── laps-2024-06-07-15_25_49-thumb.png
├── telemetry-v1-2024-06-07-15_25_42.csv
├── telemetry-v1-2025-12-20-10_03_11.csv  # telemetry-only, NO matching video 🚩
└── telemetry-v1-2025-12-20-10_03_43.csv  # telemetry-only, NO matching video 🚩
```

**File inventory (491 files total):** 472 `.mp4`, 9 `.png`, 6 `.json`, 4 `.csv`.
Breakdown: 464 per-camera segments (116 timestamps × 4 cameras) + 6 `event.mp4`
+ 2 Track Mode videos = 472 mp4. No other sidecar/metadata types exist (no `.gpx`,
no `.srt`, no `.txt`, no embedded subtitle/GPS tracks).

---

## 2. File-naming conventions

| Context | Pattern | Example |
|---|---|---|
| Camera segment | `YYYY-MM-DD_HH-MM-SS-<camera>.mp4` | `2026-06-04_17-03-32-front.mp4` |
| Saved-event folder | `YYYY-MM-DD_HH-MM-SS/` | `2024-06-04_14-58-41/` |
| Event preview | `event.mp4`, `event.json`, `thumb.png` | (inside each event folder) |
| Track Mode video | `laps-YYYY-MM-DD-HH_MM_SS.mp4` | `laps-2024-06-04-15_34_11.mp4` |
| Track Mode telemetry | `telemetry-v1-YYYY-MM-DD-HH_MM_SS.csv` | `telemetry-v1-2024-06-04-15_34_09.csv` |

- The timestamp in a **camera-segment filename is the segment's start wall-clock
  time** (local time, no timezone). This is the primary key for time-syncing the
  four cameras and for laying segments on a continuous timeline.
- In `SavedClips`, the **folder** timestamp ≈ event time; the **segments inside**
  are timestamped ~10 minutes earlier (the pre-event buffer). E.g. event folder
  `2024-06-04_14-58-41` contains segments `14-47-29` … `14-57-35`.
- Track Mode `laps-*` and `telemetry-v1-*` filenames for the same session differ
  by a couple of seconds (`15_34_11` video vs `15_34_09` csv) — they are paired by
  proximity, **not** exact-equal timestamps. 🚩 Pairing rule = nearest timestamp
  on the same date; confirm there's never ambiguity with >1 session per day.

---

## 3. Cameras

Exactly **4 camera angles**, consistent across the entire TeslaCam dataset
(116 segments each → 116 `front`, 116 `back`, 116 `left_repeater`, 116 `right_repeater`):

| Suffix | View | Notes from frame inspection |
|---|---|---|
| `front` | Forward, wide | Clean wide-angle through windshield |
| `back` | Rear, fisheye | Strong barrel distortion; rear bumper visible |
| `left_repeater` | Down the left side, rearward | Mounted in front fender |
| `right_repeater` | Down the right side, rearward | Mounted in front fender |

🚩 **Camera set is model/firmware-dependent.** Newer Tesla vehicles also produce
`left_pillar` and `right_pillar` (B-pillar) cameras, and Cybertruck differs again.
This sample has none, but the app should **discover camera angles dynamically from
filenames** rather than hardcoding these four. Track Mode here is **front-only**.

---

## 4. Video format (verified with ffprobe)

| Property | TeslaCam segments | Track Mode `laps-*` | `event.mp4` |
|---|---|---|---|
| Container | MP4 | MP4 | MP4 |
| Video codec | H.264 (High) | H.264 | **MPEG-4 Part 2** |
| Resolution | **1280×960** (4:3) | 1280×960 | **640×480** |
| Real frame rate | **~36 fps** | ~36 fps | **6 fps** |
| Audio | **none** | none | none |
| Segment length | ~60 s (observed 59–67 s) | one ~5.5 min file | 10 s |
| Bitrate | ~5.2 Mbps | ~5.2 Mbps | ~0.4 Mbps |

🚩 **Critical: the reported nominal frame rate is bogus.** `r_frame_rate` reads
`10000/1` (a placeholder). Actual rate from frame counting is ~36 fps
(`avg_frame_rate` = 22960000/637279 ≈ 36.03; 2295 frames / 63.73 s ≈ 36.0). The
container `time_base` is `1/10000`. **Implication: do not rely on a fixed fps for
seeking/sync — drive playback by presentation timestamps (PTS) / wall-clock, not
frame index.** Most player engines handle this if we seek by time, not by frame.

- **`event.mp4`** is a separate Tesla-generated 10-second, 6 fps, 640×480
  single-camera (front) preview — **not** a 2×2 composite and **not** the full
  footage. It is a teaser only; the real footage is the four per-camera segment
  streams. We will likely ignore `event.mp4` for playback and use it (or
  `thumb.png`) only for library thumbnails.
- **`thumb.png`** files are tiny 128×96 (4:3) preview stills.
- **No audio anywhere** — simplifies sync (no A/V drift to manage) but means no
  sound track to play.

---

## 5. `event.json` — SavedClips location & event metadata

Present **only** in `SavedClips/*/` (6 files). `RecentClips` and Track Mode have
no `event.json`. Schema (all values are JSON strings, even the numbers):

```json
{
  "timestamp": "2024-06-04T14:58:34",          // ISO-8601 local, no timezone
  "city": "Springfield",                         // location values fictionalized
  "est_lat": "40.1234",                          // ~4 decimal places (~10 m)
  "est_lon": "-74.5678",
  "reason": "user_interaction_dashcam_icon_tapped",
  "camera": "0"                                  // 🚩 meaning unconfirmed (see below)
}
```

Observed `reason` values across the 6 events:
`user_interaction_dashcam_icon_tapped`, `user_interaction_dashcam_launcher_action_tapped`,
`user_interaction_honk` (×3), `vehicle_auto_emergency_braking`.

- **Location here is a single coarse point** (the event location), **not a track.**
  All sample events cluster within one suburban metro area (a few towns apart).
- `camera: "0"` 🚩 — likely the camera index that triggered/was-focused for the
  event; exact semantics unconfirmed. Low priority.

---

## 6. `telemetry-v1-*.csv` — Track Mode telemetry (the rich data source)

29 columns, comma-separated, one header row. This is the **only source of dense,
time-varying GPS + vehicle data** in the dataset.

**Columns:** `Lap`, `Elapsed Time (ms)`, `Speed (MPH)`, `Latitude (decimal)`,
`Longitude (decimal)`, `Lateral Acceleration (m/s^2)`, `Longitudinal Acceleration
(m/s^2)`, `Throttle Position (%)`, `Brake Pressure (bar)`, `Steering Angle (deg)`,
`Steering Angle Rate (deg/s)`, `Yaw Rate (rad/s)`, `Power Level (KW)`, `State of
Charge (%)`, `Tire Pressure {FL,FR,RL,RR} (bar)`, `Brake Temperature {FL,FR,RL,RR}
(% est.)`, `Front/Rear Inverter Temp (%)`, `Battery Temp (%)`, `Tire Slip
{FL,FR,RL,RR} (% est.)`.

Sample sizes: 15 235 / 5 393 / 388 / 958 data rows for the four CSVs.

### Timing semantics (important & partly ambiguous 🚩)
- **`Lap`** increments `0 → 1 → 2`. **Lap 0 is the warm-up/out lap** and its
  `Elapsed Time (ms)` is **always 0**. Timed laps (≥1) have a running lap timer
  that **resets each lap** (lap 1: 17 → 181 505 ms ≈ 181.5 s; lap 2: a 4.4 s
  partial). The two `2025-12-20` files have `Lap`=0 and `Elapsed`=0 throughout
  (free-roam / no timed laps) yet non-zero speed — telemetry without lap timing.
- **`Elapsed Time (ms)` is therefore NOT a usable global time axis** (it's zero in
  warm-up and resets per lap). ~23 % of rows are exact duplicates of the previous
  row.
- **Inferred sample rate ≈ 45 Hz** (lap 1: 181 505 ms / 8135 rows ≈ 22.3 ms/row;
  and 15 235 rows / 332.9 s video ≈ 45.8 Hz overall — consistent).
- **🚩 Recommended sync strategy:** treat the CSV as uniformly sampled over the
  paired video's duration, i.e. `t(row) = row_index / (n_rows − 1) × video_duration`.
  This is robust to the Elapsed-Time quirk. To be validated against you — an
  alternative is to anchor lap boundaries to known timestamps if a more exact
  mapping is needed.

### GPS
- `Latitude`/`Longitude` are 6-decimal-place decimal degrees (~0.1 m precision) at
  ~45 Hz → a **dense, smooth, mappable track** for the whole session. (The three
  Track Mode sample dates — 2024-06-04, 2024-06-07, 2025-12-20 — each map to a
  distinct nearby site.)

---

## 7. Implications for the app (and open questions)

These shape the spec — flagging before any build.

1. **Two very different playback modes:**
   - **TeslaCam mode** = up-to-4 synchronized camera angles, concatenate ~1-min
     segments into one timeline, **no telemetry**, location is at most a **single
     event pin** (SavedClips) or **nothing at all** (RecentClips).
   - **Track Mode** = a **single** video + a **dense synced GPS track + rich HUD**
     (speed, accel, throttle, brake, steering, lap times, SoC, temps…).

2. 🚩 **The "map synced to playback position" feature is only fully possible in
   Track Mode.** For TeslaCam SavedClips we can show one approximate pin; for
   RecentClips there is **no location data**. **Question for you:** is the moving
   map a Track-Mode-first feature, with a static/absent pin for TeslaCam — or do
   you expect a moving map for dashcam footage too (which the data can't support)?

3. 🚩 **HUD content differs by mode.** TeslaCam HUD can only show clip time /
   wall-clock / camera labels / event reason. Track Mode HUD can show the full
   telemetry. **Question:** which HUD fields matter most to you for each mode?

4. **Sync must be time/PTS-based, not frame-based** (bogus fps; per-camera
   durations differ by ~0.1–0.4 s within a segment group). Anchor the 4 cameras to
   their shared filename start-time; tolerate missing cameras and ragged ends.

5. **Segments are not uniformly spaced.** Observed a ~2-min gap and an 11-second
   stub segment within one SavedClip (`…17-25-32` → `…17-27-23` → `…17-27-34`).
   The timeline must be built from actual file start-times + measured durations,
   handling gaps and overlaps — not "60 s × index".

6. **Large data, no audio.** 17 GB for TeslaCam alone; four 1280×960 H.264 streams
   must decode in lockstep. Performance (hardware-accelerated decode of 4 simultaneous
   streams) is the key technical risk and a primary input to the stack choice.

7. **Example footage must not be committed to git** (17 GB). `TeslaCam/` and
   `TeslaTrackMode/` are git-ignored; they stay on disk locally as test fixtures.

---

## 8. Quick-reference facts

- Cameras: `front`, `back`, `left_repeater`, `right_repeater` (discover dynamically).
- Resolution 1280×960 @ ~36 fps, H.264, no audio. Nominal fps in container = bogus.
- Segment ≈ 60 s; SavedClips = ~10 min pre-event buffer per event.
- Location: dense in Track Mode telemetry CSV (~45 Hz GPS); single coarse point in
  SavedClips `event.json`; **absent** in RecentClips.
- Telemetry time axis: derive from row index × video duration (Elapsed Time resets per lap).
- All sample data: June 2024 + Dec 2025, one suburban metro area.
</content>
</invoke>
