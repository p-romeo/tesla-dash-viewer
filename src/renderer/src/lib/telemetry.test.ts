import { describe, expect, it } from 'vitest'
import { parseTelemetry } from './telemetry'

const HEADER = [
  'Lap',
  'Elapsed Time (ms)',
  'Speed (MPH)',
  'Latitude (decimal)',
  'Longitude (decimal)',
  'Lateral Acceleration (m/s^2)',
  'Longitudinal Acceleration (m/s^2)',
  'Throttle Position (%)',
  'Brake Pressure (bar)',
  'Steering Angle (deg)',
  'Power Level (KW)',
  'State of Charge (%)'
].join(',')

interface Row {
  lap?: number
  elapsed?: number
  speed?: number
  lat?: number
  lon?: number
  brake?: number
}

function row(r: Row): string {
  return [
    r.lap ?? 0,
    r.elapsed ?? 0,
    r.speed ?? 0,
    r.lat ?? 0,
    r.lon ?? 0,
    0,
    0,
    0,
    r.brake ?? 0,
    0,
    0,
    0
  ].join(',')
}

function csv(rows: Row[]): string {
  return [HEADER, ...rows.map(row)].join('\n')
}

describe('parseTelemetry', () => {
  it('parses channels by header name', () => {
    const t = parseTelemetry(csv([{ lap: 2, speed: 88.5, lat: 40.7, lon: -74.2, brake: 12 }]))
    expect(t.samples).toHaveLength(1)
    expect(t.samples[0]).toMatchObject({
      lap: 2,
      speedMph: 88.5,
      lat: 40.7,
      lon: -74.2,
      brakeBar: 12
    })
  })

  it('strips a UTF-8 BOM so the first column (Lap) still resolves', () => {
    const t = parseTelemetry('\uFEFF' + csv([{ lap: 3, speed: 50 }]))
    expect(t.samples[0].lap).toBe(3) // without the strip this silently reads 0
  })

  it('handles CRLF line endings and a trailing newline', () => {
    const t = parseTelemetry(csv([{ speed: 10 }, { speed: 20 }]).replace(/\n/g, '\r\n') + '\r\n')
    expect(t.samples.map((s) => s.speedMph)).toEqual([10, 20])
  })

  it('is independent of column order', () => {
    const shuffled = ['Speed (MPH)', 'Lap', 'Elapsed Time (ms)'].join(',') + '\n' + '42,5,100'
    const t = parseTelemetry(shuffled)
    expect(t.samples[0].speedMph).toBe(42)
    expect(t.samples[0].lap).toBe(5)
  })

  it('degrades a missing column to 0 instead of throwing', () => {
    const noBrake = 'Lap,Speed (MPH)\n1,30'
    const t = parseTelemetry(noBrake)
    expect(t.samples[0].brakeBar).toBe(0)
    expect(t.samples[0].speedMph).toBe(30)
  })

  it('degrades non-numeric cells to 0', () => {
    const t = parseTelemetry('Lap,Speed (MPH)\n1,not-a-number')
    expect(t.samples[0].speedMph).toBe(0)
  })

  it('tracks the session peak brake pressure', () => {
    const t = parseTelemetry(csv([{ brake: 3 }, { brake: 41.2 }, { brake: 7 }]))
    expect(t.maxBrakeBar).toBe(41.2)
  })

  it('returns no samples for an empty or header-only file', () => {
    expect(parseTelemetry('').samples).toHaveLength(0)
    expect(parseTelemetry(HEADER).samples).toHaveLength(0)
  })
})

describe('sampleAt', () => {
  it('returns null with no samples', () => {
    expect(parseTelemetry('').sampleAt(0, 60)).toBeNull()
  })

  it('returns the single sample regardless of time', () => {
    const t = parseTelemetry(csv([{ speed: 99 }]))
    expect(t.sampleAt(123, 60)?.speedMph).toBe(99)
  })

  it('falls back to the first sample for a non-positive duration', () => {
    const t = parseTelemetry(csv([{ speed: 1 }, { speed: 2 }]))
    expect(t.sampleAt(10, 0)?.speedMph).toBe(1)
    expect(t.sampleAt(10, NaN)?.speedMph).toBe(1)
  })

  it('maps free-roam files (all lap 0, elapsed 0) uniformly across the clip', () => {
    // 5 rows over a 40s clip -> rows sit at 0, 10, 20, 30, 40s.
    const t = parseTelemetry(csv([0, 1, 2, 3, 4].map((i) => ({ speed: i }))))
    expect(t.sampleAt(0, 40)?.speedMph).toBe(0)
    expect(t.sampleAt(11, 40)?.speedMph).toBe(1) // nearest is 10, not 20
    expect(t.sampleAt(39, 40)?.speedMph).toBe(4)
    expect(t.sampleAt(1000, 40)?.speedMph).toBe(4) // clamped past the end
    expect(t.sampleAt(-5, 40)?.speedMph).toBe(0) // clamped before the start
  })

  it('anchors timed laps by their own elapsed timer (lap-aware axis)', () => {
    // Warm-up: 4 rows, lap 0, elapsed stuck at 0. Lap 1 and lap 2: 10s each by
    // their final Elapsed value. Clip is 40s -> warm-up owns the leftover 20s.
    // Expected row times: warm-up 0/6.67/13.33/20, lap1 20/25/30, lap2 30/35/40.
    const rows: Row[] = [
      { lap: 0, speed: 0 },
      { lap: 0, speed: 1 },
      { lap: 0, speed: 2 },
      { lap: 0, speed: 3 },
      { lap: 1, elapsed: 0, speed: 10 },
      { lap: 1, elapsed: 5000, speed: 11 },
      { lap: 1, elapsed: 10000, speed: 12 },
      { lap: 2, elapsed: 0, speed: 20 },
      { lap: 2, elapsed: 5000, speed: 21 },
      { lap: 2, elapsed: 10000, speed: 22 }
    ]
    const t = parseTelemetry(csv(rows))
    // Mid-warm-up: nearest of {0, 6.67, 13.33, 20} to 7 is 6.67.
    expect(t.sampleAt(7, 40)?.speedMph).toBe(1)
    // Lap 1's middle row sits exactly at 20 + 5 = 25s (not at the warped position
    // a uniform row-index mapping would give it).
    expect(t.sampleAt(24.9, 40)?.speedMph).toBe(11)
    expect(t.sampleAt(25.1, 40)?.speedMph).toBe(11)
    // Lap 2's middle row at 30 + 5 = 35s.
    expect(t.sampleAt(35, 40)?.speedMph).toBe(21)
    // End of clip is lap 2's last row.
    expect(t.sampleAt(40, 40)?.speedMph).toBe(22)
  })

  it('keeps the axis monotonic across duplicate elapsed values', () => {
    // Stationary-car duplicates: repeated elapsed inside a timed lap must not
    // break the binary search (axis stays non-decreasing).
    const rows: Row[] = [
      { lap: 1, elapsed: 0, speed: 0 },
      { lap: 1, elapsed: 1000, speed: 1 },
      { lap: 1, elapsed: 1000, speed: 2 },
      { lap: 1, elapsed: 2000, speed: 3 }
    ]
    const t = parseTelemetry(csv(rows))
    expect(t.sampleAt(0, 2)?.speedMph).toBe(0)
    expect(t.sampleAt(2, 2)?.speedMph).toBe(3)
  })

  it('rebuilds the cached axis when the clip duration changes', () => {
    const t = parseTelemetry(csv([0, 1, 2].map((i) => ({ speed: i }))))
    // duration 40: rows at 0/20/40 -> t=30 is nearest row 2 (ties go later).
    expect(t.sampleAt(30, 40)?.speedMph).toBe(2)
    // duration 80: rows at 0/40/80 -> t=30 is nearest row 1.
    expect(t.sampleAt(30, 80)?.speedMph).toBe(1)
  })

  it('resolves an exact midpoint to the later row', () => {
    const t = parseTelemetry(csv([{ speed: 0 }, { speed: 1 }]))
    // Rows at 0 and 10; 5 is equidistant — nearestRow keeps the later row.
    expect(t.sampleAt(5, 10)?.speedMph).toBe(1)
  })
})
