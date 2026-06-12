// Renderer-side parser for the Track Mode telemetry CSV (NOTES.md §6). Pulled
// forward from M5 so the M4 HUD can show real telemetry; M5's map reuses lat/lon.
// Fetched over the media:// protocol (text/csv, supportFetchAPI) — see App.tsx.

export interface TelemetrySample {
  lap: number
  speedMph: number
  lat: number
  lon: number
  latAccel: number
  lonAccel: number
  throttlePct: number
  brakeBar: number
  steeringDeg: number
  powerKw: number
  socPct: number
}

export interface Telemetry {
  samples: TelemetrySample[]
  /** Peak brake pressure (bar) over the session. Brake is a pressure, not a 0–100%
   *  channel, so the HUD bar normalizes against this instead of an arbitrary scale. */
  maxBrakeBar: number
  /** Nearest sample for a playback time, using a video-time axis anchored to the
   *  clip duration (see buildTimeAxis — uniform row-index mapping is wrong here). */
  sampleAt(timeSeconds: number, durationSeconds: number): TelemetrySample | null
}

// Exact NOTES.md §6 header names; matched by name so column order / the full
// 29-column set don't matter and missing channels degrade to 0 rather than throw.
const COLS = {
  lap: 'Lap',
  speedMph: 'Speed (MPH)',
  lat: 'Latitude (decimal)',
  lon: 'Longitude (decimal)',
  latAccel: 'Lateral Acceleration (m/s^2)',
  lonAccel: 'Longitudinal Acceleration (m/s^2)',
  throttlePct: 'Throttle Position (%)',
  brakeBar: 'Brake Pressure (bar)',
  steeringDeg: 'Steering Angle (deg)',
  powerKw: 'Power Level (KW)',
  socPct: 'State of Charge (%)'
} as const

export function parseTelemetry(csv: string): Telemetry {
  // Strip a leading UTF-8 BOM (code point 0xFEFF) — otherwise header[0] is "<BOM>Lap"
  // and the first column (Lap) fails its name lookup and silently reads 0 all session.
  const body = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0)
  const samples: TelemetrySample[] = []
  // Per-row lap timer (ms). Resets each lap and is 0 through the timer-less warm-up
  // lap; buildTimeAxis uses it to place the timed laps accurately.
  const elapsedMs: number[] = []
  let maxBrakeBar = 0
  if (lines.length >= 2) {
    const header = lines[0].split(',').map((h) => h.trim())
    const idx = {} as Record<keyof typeof COLS, number>
    for (const key of Object.keys(COLS) as (keyof typeof COLS)[]) {
      idx[key] = header.indexOf(COLS[key])
    }
    const iElapsed = header.indexOf('Elapsed Time (ms)')
    const num = (cells: string[], i: number): number => {
      if (i < 0) return 0
      const v = parseFloat(cells[i])
      return isFinite(v) ? v : 0
    }
    for (let r = 1; r < lines.length; r++) {
      const cells = lines[r].split(',')
      const brakeBar = num(cells, idx.brakeBar)
      if (brakeBar > maxBrakeBar) maxBrakeBar = brakeBar
      elapsedMs.push(num(cells, iElapsed))
      samples.push({
        lap: num(cells, idx.lap),
        speedMph: num(cells, idx.speedMph),
        lat: num(cells, idx.lat),
        lon: num(cells, idx.lon),
        latAccel: num(cells, idx.latAccel),
        lonAccel: num(cells, idx.lonAccel),
        throttlePct: num(cells, idx.throttlePct),
        brakeBar,
        steeringDeg: num(cells, idx.steeringDeg),
        powerKw: num(cells, idx.powerKw),
        socPct: num(cells, idx.socPct)
      })
    }
  }

  // The axis depends on the clip duration, so build it lazily and cache it — the
  // duration is stable for a session, so this runs once, not per HUD frame.
  let axis: Float64Array | null = null
  let axisForDuration = -1

  return {
    samples,
    maxBrakeBar,
    sampleAt(timeSeconds, durationSeconds) {
      const n = samples.length
      if (n === 0) return null
      if (n === 1 || !(durationSeconds > 0)) return samples[0]
      if (!axis || axisForDuration !== durationSeconds) {
        axis = buildTimeAxis(samples, elapsedMs, durationSeconds)
        axisForDuration = durationSeconds
      }
      return samples[nearestRow(axis, timeSeconds)]
    }
  }
}

// Tesla's telemetry time axis can't be recovered exactly (NOTES.md §6): "Elapsed
// Time (ms)" resets each lap and is 0 throughout the timer-less warm-up lap, which
// can be ~45% of the rows and ~23% exact duplicates (stationary car). Uniform
// row-index mapping therefore both compresses the warm-up and bows mid-lap by
// seconds vs the video. Instead we anchor to the measured clip duration: each timed
// lap (>=1) is placed by its own Elapsed timer, and the leftover time is spread
// uniformly across the timer-less rows. Returns per-row playback seconds (monotonic
// non-decreasing). Free-roam files (all lap 0) degrade to the old uniform mapping.
function buildTimeAxis(
  samples: TelemetrySample[],
  elapsedMs: number[],
  durationSeconds: number
): Float64Array {
  const n = samples.length
  const out = new Float64Array(n)

  // Contiguous lap segments (Lap is non-decreasing: 0 -> 1 -> 2).
  type Seg = { start: number; end: number; timedSec: number }
  const segs: Seg[] = []
  let s = 0
  for (let r = 1; r <= n; r++) {
    if (r === n || samples[r].lap !== samples[s].lap) {
      const end = r - 1
      // A timed lap's final Elapsed value is its duration; 0 means no timer (warm-up).
      const timedSec = samples[s].lap >= 1 ? elapsedMs[end] / 1000 : 0
      segs.push({ start: s, end, timedSec })
      s = r
    }
  }

  const timedTotal = segs.reduce((a, seg) => a + Math.max(0, seg.timedSec), 0)
  let untimedRows = 0
  for (const seg of segs) if (seg.timedSec <= 0) untimedRows += seg.end - seg.start + 1
  // Whatever clip time the timed laps don't account for is the warm-up/idle.
  const untimedTotal = Math.max(0, durationSeconds - timedTotal)

  let cursor = 0
  for (const seg of segs) {
    const rows = seg.end - seg.start + 1
    if (seg.timedSec > 0) {
      for (let r = seg.start; r <= seg.end; r++) out[r] = cursor + elapsedMs[r] / 1000
      cursor += seg.timedSec
    } else {
      const segDur = untimedRows > 0 ? (untimedTotal * rows) / untimedRows : 0
      for (let r = seg.start; r <= seg.end; r++) {
        out[r] = cursor + (rows > 1 ? ((r - seg.start) / (rows - 1)) * segDur : 0)
      }
      cursor += segDur
    }
  }
  return out
}

// Nearest row to a playback time on a non-decreasing axis (binary search).
function nearestRow(axis: Float64Array, t: number): number {
  const n = axis.length
  if (t <= axis[0]) return 0
  if (t >= axis[n - 1]) return n - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (axis[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && t - axis[lo - 1] < axis[lo] - t ? lo - 1 : lo
}
