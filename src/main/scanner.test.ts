import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SegmentGroup } from '@shared/types'
import {
  scanDrive,
  dashcamEpoch,
  cameraSort,
  groupContiguous,
  groupSegmentsIntoSessions,
  GAP_THRESHOLD_MS,
  ASSUMED_CLIP_SECONDS
} from './scanner'

// ---------------------------------------------------------------------------
// Unit: pure grouping helpers
// ---------------------------------------------------------------------------

let grpNo = 0
function grp(
  startEpochMs: number,
  measured?: number,
  source: SegmentGroup['source'] = 'RecentClips',
  eventFolder?: string
): SegmentGroup {
  return {
    id: `g${grpNo++}`,
    timestamp: `ts${startEpochMs}`,
    startEpochMs,
    source,
    eventFolder,
    cameras: [],
    measuredDurationSeconds: measured
  }
}

describe('dashcamEpoch', () => {
  it('parses filename stamps as local time, matching Date construction', () => {
    expect(dashcamEpoch('2026-06-04', '17', '03', '32')).toBe(
      new Date(2026, 5, 4, 17, 3, 32).getTime()
    )
  })
})

describe('cameraSort', () => {
  it('orders known angles by CAMERA_ORDER, unknowns after, alphabetically', () => {
    const cams = ['right_repeater', 'zeta_cam', 'front', 'aux_cam', 'back']
    expect([...cams].sort(cameraSort)).toEqual([
      'front',
      'back',
      'right_repeater',
      'aux_cam',
      'zeta_cam'
    ])
  })
})

describe('groupContiguous', () => {
  it('keeps the systematic ~6-12s intra-drive gap in one session', () => {
    // Real cadence: ~64.6s clips arriving every ~71s. The apparent 6.4s gap is
    // NOT a recording stop and must not split the drive.
    const groups = [grp(0, 64.6), grp(71_000, 64.6), grp(142_000, 64.6)]
    const sessions = groupContiguous(groups, 'RecentClips', undefined)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].segments).toHaveLength(3)
    // Content-only timeline: clips abut by measured length, no dead air.
    expect(sessions[0].segments.map((s) => s.offsetSeconds)).toEqual([0, 64.6, 129.2])
    expect(sessions[0].durationSeconds).toBeCloseTo(193.8, 6)
  })

  it('keeps a gap exactly at the threshold together, splits just past it', () => {
    const endOfFirst = 60_000 // 60s clip starting at 0
    const atThreshold = [grp(0, 60), grp(endOfFirst + GAP_THRESHOLD_MS, 60)]
    expect(groupContiguous(atThreshold, 'RecentClips', undefined)).toHaveLength(1)

    const pastThreshold = [grp(0, 60), grp(endOfFirst + GAP_THRESHOLD_MS + 1, 60)]
    const sessions = groupContiguous(pastThreshold, 'RecentClips', undefined)
    expect(sessions).toHaveLength(2)
    expect(sessions[0].segments).toHaveLength(1)
    expect(sessions[1].segments).toHaveLength(1)
  })

  it('falls back to the assumed clip length when duration is unmeasured', () => {
    // Unmeasured clips count as ASSUMED_CLIP_SECONDS for both gap math and offsets.
    const groups = [grp(0), grp(ASSUMED_CLIP_SECONDS * 1000 + GAP_THRESHOLD_MS, 30)]
    const one = groupContiguous(groups, 'RecentClips', undefined)
    expect(one).toHaveLength(1)
    expect(one[0].segments[1].offsetSeconds).toBe(ASSUMED_CLIP_SECONDS)
  })

  it('titles sessions by source and start time', () => {
    const start = new Date(2026, 0, 15, 9, 30, 0).getTime()
    const [recent] = groupContiguous([grp(start, 60)], 'RecentClips', undefined)
    expect(recent.title).toBe('Recent Drive · Jan 15, 2026 09:30:00')
    const [other] = groupContiguous([grp(start, 60, 'other')], 'other', undefined)
    expect(other.title).toBe('Clips · Jan 15, 2026 09:30:00')
  })

  it('returns nothing for no groups', () => {
    expect(groupContiguous([], 'RecentClips', undefined)).toEqual([])
  })
})

describe('overlap handling', () => {
  it('clamps a clip that overruns the next start and records the trim', () => {
    // Clip 0 measures 70s but clip 1 starts 60s later: a 10s start-to-start
    // overlap. The earlier clip's effective duration clamps to the room.
    const groups = [grp(0, 70), grp(60_000, 64.6)]
    const [session] = groupContiguous(groups, 'RecentClips', undefined)
    expect(session.segments).toHaveLength(2)
    expect(session.segments[0].durationSeconds).toBe(60)
    expect(session.segments[0].overlapTrimmedSeconds).toBeCloseTo(10, 6)
    // The timeline advances by the clamped duration, not the raw one.
    expect(session.segments[1].offsetSeconds).toBe(60)
    expect(session.segments[1].overlapTrimmedSeconds).toBeUndefined()
    expect(session.durationSeconds).toBeCloseTo(124.6, 6)
  })

  it('does not trim exact abutment or gapped clips', () => {
    const abut = [grp(0, 60), grp(60_000, 60)]
    const [s1] = groupContiguous(abut, 'RecentClips', undefined)
    expect(s1.segments[0].durationSeconds).toBe(60)
    expect(s1.segments[0].overlapTrimmedSeconds).toBeUndefined()

    // The systematic intra-drive case (~64.6s clips on a ~71s cadence) is a
    // gap, never an overlap — it must stay untrimmed.
    const gapped = [grp(0, 64.6), grp(71_000, 64.6)]
    const [s2] = groupContiguous(gapped, 'RecentClips', undefined)
    expect(s2.segments[0].durationSeconds).toBeCloseTo(64.6, 6)
    expect(s2.segments[0].overlapTrimmedSeconds).toBeUndefined()
  })

  it('never trims the final clip of a session', () => {
    const groups = [grp(0, 60), grp(60_000, 999)]
    const [session] = groupContiguous(groups, 'RecentClips', undefined)
    expect(session.segments[1].durationSeconds).toBe(999)
    expect(session.segments[1].overlapTrimmedSeconds).toBeUndefined()
  })

  it('clamps overlaps inside SavedClips event folders too', () => {
    // SavedClips bypass groupContiguous (one session per event folder), so the
    // clamp must live in the shared timeline builder to cover them.
    const groups = [
      grp(0, 75, 'SavedClips', 'evt'),
      grp(60_000, 60, 'SavedClips', 'evt')
    ]
    const sessions = groupSegmentsIntoSessions(groups, {}, {
      savedByFolder: new Map<string, string>()
    })
    expect(sessions).toHaveLength(1)
    expect(sessions[0].segments[0].durationSeconds).toBe(60)
    expect(sessions[0].segments[0].overlapTrimmedSeconds).toBeCloseTo(15, 6)
  })
})

describe('groupSegmentsIntoSessions', () => {
  const noThumbs = { savedByFolder: new Map<string, string>() }

  it('builds SavedClips titles from the event reason', () => {
    const groups = [grp(0, 60, 'SavedClips', 'evt-folder')]
    const sessions = groupSegmentsIntoSessions(
      groups,
      { 'evt-folder': { timestamp: 'x', reason: 'sentry_aware_object_detection' } },
      noThumbs
    )
    expect(sessions[0].title).toBe('Sentry Event (sentry aware object detection)')
  })

  it('falls back to the folder name when the event has no reason', () => {
    const groups = [grp(0, 60, 'SavedClips', '2026-01-03_08-00-00')]
    const sessions = groupSegmentsIntoSessions(groups, {}, noThumbs)
    expect(sessions[0].title).toBe('Sentry Event · 2026-01-03_08-00-00')
  })

  it('never gap-splits SavedClips — one session per event folder', () => {
    // Two clips an hour apart in the same event folder stay one session
    // (in-event gaps are elided by design; see scanner.ts).
    const groups = [
      grp(0, 60, 'SavedClips', 'evt'),
      grp(3_600_000, 60, 'SavedClips', 'evt')
    ]
    const sessions = groupSegmentsIntoSessions(groups, {}, noThumbs)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].segments).toHaveLength(2)
  })

  it('sorts sessions of all sources by start time', () => {
    const groups = [
      grp(200_000_000, 60, 'SavedClips', 'evt'),
      grp(100_000_000, 60, 'RecentClips'),
      grp(300_000_000, 60, 'other')
    ]
    const sessions = groupSegmentsIntoSessions(groups, {}, noThumbs)
    expect(sessions.map((s) => s.source)).toEqual(['RecentClips', 'SavedClips', 'other'])
  })
})

// ---------------------------------------------------------------------------
// Integration: scanDrive against on-disk fixtures
// ---------------------------------------------------------------------------

/** Minimal valid MP4: ftyp + moov/mvhd(v0) declaring `seconds` of content. */
function mp4WithDuration(seconds: number): Buffer {
  const mvhdPayload = Buffer.alloc(100)
  mvhdPayload.writeUInt32BE(1000, 12) // timescale
  mvhdPayload.writeUInt32BE(Math.round(seconds * 1000), 16) // duration
  const mvhd = Buffer.alloc(8 + 100)
  mvhd.writeUInt32BE(108, 0)
  mvhd.write('mvhd', 4, 'latin1')
  mvhdPayload.copy(mvhd, 8)
  const moov = Buffer.alloc(8)
  moov.writeUInt32BE(8 + 108, 0)
  moov.write('moov', 4, 'latin1')
  const ftyp = Buffer.alloc(16)
  ftyp.writeUInt32BE(16, 0)
  ftyp.write('ftyp', 4, 'latin1')
  return Buffer.concat([ftyp, moov, mvhd])
}

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tesla-scan-'))
  const recent = join(root, 'TeslaCam', 'RecentClips')
  const saved1 = join(root, 'TeslaCam', 'SavedClips', '2026-01-02_12-00-00')
  const saved2 = join(root, 'TeslaCam', 'SavedClips', '2026-01-03_08-00-00')
  const track = join(root, 'TeslaTrackMode')
  await mkdir(recent, { recursive: true })
  await mkdir(saved1, { recursive: true })
  await mkdir(saved2, { recursive: true })
  await mkdir(track, { recursive: true })

  // RecentClips: a 2-clip continuous drive (71s cadence, 64.6s measured clips),
  // then a third clip after a 29-minute real gap.
  await writeFile(join(recent, '2026-01-01_10-00-00-front.mp4'), mp4WithDuration(64.6))
  await writeFile(join(recent, '2026-01-01_10-00-00-back.mp4'), Buffer.alloc(0))
  await writeFile(join(recent, '2026-01-01_10-01-11-front.mp4'), mp4WithDuration(64.6))
  await writeFile(join(recent, '2026-01-01_10-30-00-front.mp4'), mp4WithDuration(64.6))
  await writeFile(join(recent, 'thumb.png'), Buffer.from('png'))

  // SavedClips event with sidecars; event.mp4 must NOT become a camera angle.
  await writeFile(
    join(saved1, 'event.json'),
    JSON.stringify({
      timestamp: '2026-01-02T12:00:00',
      city: 'Union',
      est_lat: '40.69',
      est_lon: '-74.27',
      reason: 'sentry_aware_object_detection'
    })
  )
  await writeFile(join(saved1, 'event.mp4'), Buffer.alloc(0))
  await writeFile(join(saved1, 'thumb.png'), Buffer.from('png'))
  await writeFile(join(saved1, '2026-01-02_12-00-00-front.mp4'), mp4WithDuration(60))
  await writeFile(join(saved1, '2026-01-02_12-00-00-left_pillar.mp4'), Buffer.alloc(0))

  // Second event folder with a malformed event.json.
  await writeFile(join(saved2, 'event.json'), 'not json {')
  await writeFile(join(saved2, '2026-01-03_08-00-00-front.mp4'), mp4WithDuration(60))

  // Track Mode: one paired session (CSV starts 5s before the video), one video
  // whose nearest CSV is 20s away (outside the 15s window), one orphan CSV.
  await writeFile(join(track, 'laps-2026-01-05-14_00_05.mp4'), mp4WithDuration(300))
  await writeFile(join(track, 'laps-2026-01-05-14_00_05-thumb.png'), Buffer.from('png'))
  await writeFile(join(track, 'telemetry-v1-2026-01-05-14_00_00.csv'), 'Lap\n0')
  await writeFile(join(track, 'laps-2026-01-06-09_00_00.mp4'), mp4WithDuration(120))
  await writeFile(join(track, 'telemetry-v1-2026-01-06-09_00_20.csv'), 'Lap\n0')
  await writeFile(join(track, 'telemetry-v1-2025-12-20-10_00_00.csv'), 'Lap\n0')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scanDrive (parent-directory layout)', () => {
  it('discovers groups, cameras, events, and sessions across the drive', async () => {
    const scan = await scanDrive(root)

    expect(scan.groups).toHaveLength(5) // 3 recent + 2 saved
    expect(scan.cameras).toEqual(['front', 'back', 'left_pillar'])

    // Measured duration came from the real moov header, not the fallback.
    const first = scan.groups.find((g) => g.timestamp === '2026-01-01_10-00-00')!
    expect(first.measuredDurationSeconds).toBeCloseTo(64.6, 3)
    expect(first.startEpochMs).toBe(new Date(2026, 0, 1, 10, 0, 0).getTime())
    // Within a group, cameras follow CAMERA_ORDER.
    expect(first.cameras.map((c) => c.camera)).toEqual(['front', 'back'])

    // event.mp4 was skipped — no group carries an "event" camera.
    expect(scan.groups.flatMap((g) => g.cameras).some((c) => c.camera === 'event')).toBe(false)

    // Valid event.json parsed with numeric coordinates; malformed one dropped.
    expect(scan.events['2026-01-02_12-00-00']).toMatchObject({
      city: 'Union',
      estLat: 40.69,
      estLon: -74.27,
      reason: 'sentry_aware_object_detection'
    })
    expect(scan.events['2026-01-03_08-00-00']).toBeUndefined()
  })

  it('splits RecentClips into sessions on real gaps only', async () => {
    const scan = await scanDrive(root)
    const recent = scan.sessions.filter((s) => s.source === 'RecentClips')
    expect(recent).toHaveLength(2)
    // The 71s-cadence pair is one continuous session, clips laid back-to-back.
    expect(recent[0].segments).toHaveLength(2)
    expect(recent[0].segments[1].offsetSeconds).toBeCloseTo(64.6, 3)
    // The clip 29 minutes later is its own session.
    expect(recent[1].segments).toHaveLength(1)
    // Both share the folder-level RecentClips thumb.
    expect(recent[0].thumbPath).toContain('thumb.png')
    expect(recent[0].thumbPath).toBe(recent[1].thumbPath)
  })

  it('builds one SavedClips session per event folder with its own thumb', async () => {
    const scan = await scanDrive(root)
    const saved = scan.sessions.filter((s) => s.source === 'SavedClips')
    expect(saved).toHaveLength(2)
    expect(saved[0].title).toBe('Sentry Event (sentry aware object detection)')
    expect(saved[0].thumbPath).toContain('2026-01-02_12-00-00')
    expect(saved[1].title).toBe('Sentry Event · 2026-01-03_08-00-00')
    expect(saved[1].thumbPath).toBeUndefined()
  })

  it('pairs Track videos with the nearest CSV inside the 15s window', async () => {
    const scan = await scanDrive(root)
    expect(scan.trackSessions).toHaveLength(2) // orphan CSVs create no session

    const [jan5, jan6] = scan.trackSessions
    expect(jan5.startEpochMs).toBe(new Date(2026, 0, 5, 14, 0, 5).getTime())
    expect(jan5.telemetryPath).toContain('telemetry-v1-2026-01-05-14_00_00.csv')
    expect(jan5.telemetryStartEpochMs).toBe(new Date(2026, 0, 5, 14, 0, 0).getTime())
    expect(jan5.durationSeconds).toBeCloseTo(300, 3)
    expect(jan5.thumbPath).toContain('laps-2026-01-05-14_00_05-thumb.png')

    // 20s offset is outside the pairing window: video stays unpaired.
    expect(jan6.telemetryPath).toBeUndefined()
    expect(jan6.telemetryStartEpochMs).toBeUndefined()
  })
})

describe('scanDrive (alternate layouts)', () => {
  it('accepts the TeslaCam directory itself as the root', async () => {
    const scan = await scanDrive(join(root, 'TeslaCam'))
    expect(scan.sessions.filter((s) => s.source === 'RecentClips')).toHaveLength(2)
    expect(scan.sessions.filter((s) => s.source === 'SavedClips')).toHaveLength(2)
  })

  it('falls back to scanning a flat directory of segments as "other"', async () => {
    const flat = await mkdtemp(join(tmpdir(), 'tesla-flat-'))
    try {
      await writeFile(join(flat, '2026-02-01_08-00-00-front.mp4'), mp4WithDuration(50))
      await writeFile(join(flat, '2026-02-01_08-00-00-back.mp4'), Buffer.alloc(0))
      await writeFile(join(flat, 'thumb.png'), Buffer.from('png'))
      const scan = await scanDrive(flat)
      expect(scan.groups).toHaveLength(1)
      expect(scan.groups[0].source).toBe('other')
      expect(scan.sessions).toHaveLength(1)
      expect(scan.sessions[0].title).toMatch(/^Clips · /)
      expect(scan.sessions[0].thumbPath).toBe(join(flat, 'thumb.png'))
    } finally {
      await rm(flat, { recursive: true, force: true })
    }
  })

  it('returns an empty model for an empty directory', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'tesla-empty-'))
    try {
      const scan = await scanDrive(empty)
      expect(scan.groups).toEqual([])
      expect(scan.sessions).toEqual([])
      expect(scan.trackSessions).toEqual([])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
