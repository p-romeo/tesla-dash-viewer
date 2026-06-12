import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  CameraId,
  EventMeta,
  ScanResult,
  SegmentGroup,
  TrackSession,
  FootageSession,
  SessionSegment
} from '../shared/types'
import { CAMERA_ORDER } from '../shared/types'
import { readMp4DurationSeconds } from './mp4Duration'

/** Fallback clip length when an MP4's real duration can't be measured. */
export const ASSUMED_CLIP_SECONDS = 60
// Only a real recording stop ends one video and starts the next. Within a single
// continuous drive, Tesla's ~64s clips arrive on a ~71s cadence, so consecutive
// clips show a systematic ~6-12s "gap" (start delta minus measured duration) that
// is NOT a discontinuity. The threshold must sit well above that band; a genuine
// drive boundary (car parked/off) is minutes long. (A 3s threshold shattered every
// drive into per-clip sessions — see the gap distribution probed against the sample.)
export const GAP_THRESHOLD_MS = 60_000

/** Clip length in millis: measured if available, else the fallback. */
function clipMs(g: SegmentGroup): number {
  return (g.measuredDurationSeconds ?? ASSUMED_CLIP_SECONDS) * 1000
}

/** The camera file to measure a group's duration from (front preferred). */
function cameraForDuration(group: SegmentGroup): string | undefined {
  const front = group.cameras.find((c) => c.camera === 'front')
  return (front ?? group.cameras[0])?.path
}

/** Matches a per-camera dashcam segment: `YYYY-MM-DD_HH-MM-SS-<camera>.mp4`. */
const SEGMENT_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(.+)\.mp4$/
/** Matches a Track Mode video: `laps-YYYY-MM-DD-HH_MM_SS.mp4`. */
const LAPS_RE = /^laps-(\d{4})-(\d{2})-(\d{2})-(\d{2})_(\d{2})_(\d{2})\.mp4$/
/** Matches a Track Mode telemetry CSV: `telemetry-v1-YYYY-MM-DD-HH_MM_SS.csv`. */
const TELEMETRY_RE = /^telemetry-v1-(\d{4})-(\d{2})-(\d{2})-(\d{2})_(\d{2})_(\d{2})\.csv$/

/** Parse a `YYYY-MM-DD_HH-MM-SS` dashcam timestamp into epoch millis (local). */
export function dashcamEpoch(date: string, hh: string, mm: string, ss: string): number {
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, Number(hh), Number(mm), Number(ss)).getTime()
}

/** Parse a Track Mode `YYYY-MM-DD-HH_MM_SS` stamp into epoch millis (local). */
function trackEpoch(m: RegExpMatchArray): number {
  const [, y, mo, d, hh, mm, ss] = m
  return new Date(+y, +mo - 1, +d, +hh, +mm, +ss).getTime()
}

/** Sort cameras into a stable, human-friendly order (known angles first). */
export function cameraSort(a: CameraId, b: CameraId): number {
  const ia = CAMERA_ORDER.indexOf(a as never)
  const ib = CAMERA_ORDER.indexOf(b as never)
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return a.localeCompare(b)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readEventJson(dir: string): Promise<EventMeta | null> {
  try {
    const raw = await fs.readFile(join(dir, 'event.json'), 'utf-8')
    const j = JSON.parse(raw)
    return {
      timestamp: String(j.timestamp ?? ''),
      city: j.city,
      estLat: j.est_lat !== undefined ? Number(j.est_lat) : undefined,
      estLon: j.est_lon !== undefined ? Number(j.est_lon) : undefined,
      reason: j.reason,
      camera: j.camera !== undefined ? String(j.camera) : undefined
    }
  } catch {
    return null
  }
}

/**
 * Scan one directory for dashcam segments and accumulate them into `groups`,
 * keyed by `source|timestamp`. Non-recursive.
 */
async function scanDashcamDir(
  dir: string,
  source: SegmentGroup['source'],
  eventFolder: string | undefined,
  groups: Map<string, SegmentGroup>,
  cameras: Set<CameraId>
): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'event.mp4') continue // low-res preview; not a camera angle
    const m = name.match(SEGMENT_RE)
    if (!m) continue
    const [, date, hh, mm, ss, camera] = m
    const timestamp = `${date}_${hh}-${mm}-${ss}`
    const key = `${source}|${eventFolder ?? ''}|${timestamp}`
    let group = groups.get(key)
    if (!group) {
      group = {
        id: key,
        timestamp,
        startEpochMs: dashcamEpoch(date, hh, mm, ss),
        source,
        eventFolder,
        cameras: []
      }
      groups.set(key, group)
    }
    group.cameras.push({ camera, path: join(dir, name) })
    cameras.add(camera)
  }
}

/**
 * Scan a footage root. Accepts either a TeslaCam parent directory, a folder
 * containing `TeslaCam`/`TeslaTrackMode`, or a directory of segments directly.
 */
export async function scanDrive(root: string): Promise<ScanResult> {
  const groups = new Map<string, SegmentGroup>()
  const cameras = new Set<CameraId>()
  const trackSessions: TrackSession[] = []
  const events: Record<string, EventMeta> = {}

  // Resolve TeslaCam / TeslaTrackMode whether `root` is the parent or is itself
  // one of these folders.
  const teslaCam = (await exists(join(root, 'TeslaCam')))
    ? join(root, 'TeslaCam')
    : root
  const trackModeDir = (await exists(join(root, 'TeslaTrackMode')))
    ? join(root, 'TeslaTrackMode')
    : (await exists(join(root, 'laps')))
      ? root
      : null

  // --- TeslaCam: RecentClips (flat) ---
  await scanDashcamDir(
    join(teslaCam, 'RecentClips'),
    'RecentClips',
    undefined,
    groups,
    cameras
  )

  // --- TeslaCam: SavedClips (one folder per event) ---
  // Tesla writes one thumb.png per SavedClips event folder; resolve it per folder.
  const savedThumbByFolder = new Map<string, string>()
  const savedRoot = join(teslaCam, 'SavedClips')
  try {
    const eventDirs = await fs.readdir(savedRoot, { withFileTypes: true })
    for (const d of eventDirs) {
      if (!d.isDirectory()) continue
      const eventDir = join(savedRoot, d.name)
      await scanDashcamDir(eventDir, 'SavedClips', d.name, groups, cameras)
      const meta = await readEventJson(eventDir)
      if (meta) events[d.name] = meta
      const thumb = join(eventDir, 'thumb.png')
      if (await exists(thumb)) savedThumbByFolder.set(d.name, thumb)
    }
  } catch {
    /* no SavedClips */
  }

  // If nothing matched the TeslaCam structure, treat `root` itself as a flat
  // directory of segments (lets users point straight at a folder of clips).
  if (groups.size === 0) {
    await scanDashcamDir(root, 'other', undefined, groups, cameras)
  }

  // --- Track Mode ---
  if (trackModeDir) {
    let tmEntries: string[] = []
    try {
      tmEntries = await fs.readdir(trackModeDir)
    } catch {
      /* none */
    }
    const telemetryByStamp = new Map<string, string>()
    for (const name of tmEntries) {
      const tm = name.match(TELEMETRY_RE)
      if (tm) {
        const stamp = `${tm[1]}-${tm[2]}-${tm[3]}-${tm[4]}_${tm[5]}_${tm[6]}`
        telemetryByStamp.set(stamp, join(trackModeDir, name))
      }
    }
    for (const name of tmEntries) {
      const lm = name.match(LAPS_RE)
      if (!lm) continue
      const stamp = `${lm[1]}-${lm[2]}-${lm[3]}-${lm[4]}_${lm[5]}_${lm[6]}`
      const startEpochMs = trackEpoch(lm)
      // Pair with the nearest telemetry CSV (timestamps differ by a few seconds).
      // Keep the matched CSV's start epoch too: Tesla starts the telemetry a few
      // seconds before the video, so the HUD/map must offset by that lead-in.
      let telemetryPath: string | undefined
      let telemetryStartEpochMs: number | undefined
      let best = Infinity
      for (const [tStamp, tPath] of telemetryByStamp) {
        const tEpoch = trackEpoch(
          tStamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})_(\d{2})_(\d{2})$/)!
        )
        const delta = Math.abs(tEpoch - startEpochMs)
        if (delta < best && delta <= 15_000) {
          best = delta
          telemetryPath = tPath
          telemetryStartEpochMs = tEpoch
        }
      }
      const thumb = join(trackModeDir, name.replace(/\.mp4$/, '-thumb.png'))
      const videoPath = join(trackModeDir, name)
      // Header-only read (no decode), same cheap pass used for dashcam groups.
      const measured = await readMp4DurationSeconds(videoPath)
      trackSessions.push({
        id: `track|${stamp}`,
        timestamp: stamp,
        startEpochMs,
        videoPath,
        telemetryPath,
        telemetryStartEpochMs,
        thumbPath: (await exists(thumb)) ? thumb : undefined,
        durationSeconds: measured ?? undefined
      })
    }
  }

  // Finalize: sort camera files within each group, then groups by time.
  const groupList = [...groups.values()]
  for (const g of groupList) g.cameras.sort((a, b) => cameraSort(a.camera, b.camera))
  groupList.sort((a, b) => a.startEpochMs - b.startEpochMs)
  trackSessions.sort((a, b) => a.startEpochMs - b.startEpochMs)

  // Measure each clip's real duration from its MP4 header (cheap; no decode), so
  // the timeline is content-only and videos split on true gaps, not start deltas.
  await Promise.all(
    groupList.map(async (g) => {
      const path = cameraForDuration(g)
      if (!path) return
      const d = await readMp4DurationSeconds(path)
      if (d !== null) g.measuredDurationSeconds = d
    })
  )

  // Folder-level thumbs: RecentClips writes ONE shared thumb.png for all of its
  // (gap-split) sessions; a flat/other root keeps its thumb.png at the root.
  const recentThumbCandidate = join(teslaCam, 'RecentClips', 'thumb.png')
  const recentThumb = (await exists(recentThumbCandidate)) ? recentThumbCandidate : undefined
  const otherThumbCandidate = join(root, 'thumb.png')
  const otherThumb = (await exists(otherThumbCandidate)) ? otherThumbCandidate : undefined

  const sessions = groupSegmentsIntoSessions(groupList, events, {
    savedByFolder: savedThumbByFolder,
    recent: recentThumb,
    other: otherThumb
  })

  return {
    root,
    groups: groupList,
    sessions,
    trackSessions,
    cameras: [...cameras].sort(cameraSort),
    events
  }
}

function formatDate(epochMs: number): string {
  const d = new Date(epochMs)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[d.getMonth()]
  const day = d.getDate()
  const year = d.getFullYear()
  return `${month} ${day}, ${year}`
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** Resolved on-disk thumb.png paths, keyed by source (SavedClips are per event folder). */
interface SessionThumbs {
  savedByFolder: Map<string, string>
  recent?: string
  other?: string
}

export function groupSegmentsIntoSessions(
  groups: SegmentGroup[],
  events: Record<string, EventMeta>,
  thumbs: SessionThumbs
): FootageSession[] {
  const sessions: FootageSession[] = []

  // Group 1: SavedClips (grouped by eventFolder)
  const savedGroups = groups.filter((g) => g.source === 'SavedClips')
  const savedByFolder = new Map<string, SegmentGroup[]>()
  for (const g of savedGroups) {
    if (g.eventFolder) {
      let list = savedByFolder.get(g.eventFolder)
      if (!list) {
        list = []
        savedByFolder.set(g.eventFolder, list)
      }
      list.push(g)
    }
  }

  for (const [folderName, folderGroups] of savedByFolder) {
    folderGroups.sort((a, b) => a.startEpochMs - b.startEpochMs)
    const event = events[folderName]
    
    let title = 'Sentry Event'
    if (event?.reason) {
      title += ` (${event.reason.replace(/_/g, ' ')})`
    } else {
      title += ` · ${folderName}`
    }

    sessions.push(createSessionFromGroups(
      `session|SavedClips|${folderName}`,
      title,
      'SavedClips',
      folderName,
      folderGroups,
      thumbs.savedByFolder.get(folderName)
    ))
  }

  // Group 2: RecentClips (split into videos on real footage gaps; see groupContiguous)
  const recentGroups = groups.filter((g) => g.source === 'RecentClips')
  recentGroups.sort((a, b) => a.startEpochMs - b.startEpochMs)
  const recentSessions = groupContiguous(recentGroups, 'RecentClips', thumbs.recent)
  sessions.push(...recentSessions)

  // Group 3: other (split into videos on real footage gaps; see groupContiguous)
  const otherGroups = groups.filter((g) => g.source === 'other')
  otherGroups.sort((a, b) => a.startEpochMs - b.startEpochMs)
  const otherSessions = groupContiguous(otherGroups, 'other', thumbs.other)
  sessions.push(...otherSessions)

  // Sort sessions by start time ascending
  sessions.sort((a, b) => a.startEpochMs - b.startEpochMs)
  return sessions
}

export function groupContiguous(
  groups: SegmentGroup[],
  source: 'RecentClips' | 'other',
  thumbPath: string | undefined
): FootageSession[] {
  const sessions: FootageSession[] = []
  if (groups.length === 0) return sessions

  let currentCluster: SegmentGroup[] = [groups[0]]

  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1]
    const curr = groups[i]
    // Split on real missing footage: the gap between where prev's footage ends
    // and curr's footage starts. A gap-free run is one continuous video.
    const gap = curr.startEpochMs - (prev.startEpochMs + clipMs(prev))
    if (gap <= GAP_THRESHOLD_MS) {
      currentCluster.push(curr)
    } else {
      sessions.push(createSessionFromCluster(currentCluster, source, thumbPath))
      currentCluster = [curr]
    }
  }
  if (currentCluster.length > 0) {
    sessions.push(createSessionFromCluster(currentCluster, source, thumbPath))
  }

  return sessions
}

function createSessionFromCluster(
  cluster: SegmentGroup[],
  source: 'RecentClips' | 'other',
  thumbPath: string | undefined
): FootageSession {
  const first = cluster[0]
  const dateStr = formatDate(first.startEpochMs)
  const timeStr = formatTime(first.startEpochMs)

  const typeLabel = source === 'RecentClips' ? 'Recent Drive' : 'Clips'
  const title = `${typeLabel} · ${dateStr} ${timeStr}`

  return createSessionFromGroups(
    `session|${source}|${first.timestamp}`,
    title,
    source,
    undefined,
    cluster,
    thumbPath
  )
}

export function createSessionFromGroups(
  id: string,
  title: string,
  source: 'RecentClips' | 'SavedClips' | 'other',
  eventFolder: string | undefined,
  sortedGroups: SegmentGroup[],
  thumbPath: string | undefined
): FootageSession {
  const segments: SessionSegment[] = []
  let offsetSeconds = 0

  // Content-only timeline: lay clips back-to-back by their real measured length.
  // For RecentClips/other, groupContiguous already split on real gaps so the run
  // is gap-free. SavedClips are grouped per event folder and reach here without
  // gap-splitting, so any internal recording gap is elided (clips abut) rather
  // than shown as dead air — intentional for now; honest in-event gaps are a
  // follow-up (NOTES.md §7.5).
  for (let i = 0; i < sortedGroups.length; i++) {
    const group = sortedGroups[i]
    const next = sortedGroups[i + 1] as SegmentGroup | undefined
    let durationSeconds = group.measuredDurationSeconds ?? ASSUMED_CLIP_SECONDS

    // Start-to-start overlap: the next clip starts before this one ends. Clamp
    // this clip's effective duration to the wall-clock room before the next
    // start — otherwise the overlapped footage would play twice and the
    // per-segment HUD clock would jump backwards at the boundary. The trimmed
    // amount is kept on the segment so Diagnostics can surface it.
    let overlapTrimmedSeconds: number | undefined
    if (next) {
      const roomSeconds = Math.max((next.startEpochMs - group.startEpochMs) / 1000, 0)
      if (durationSeconds > roomSeconds) {
        overlapTrimmedSeconds = durationSeconds - roomSeconds
        durationSeconds = roomSeconds
      }
    }

    segments.push({
      group,
      offsetSeconds,
      durationSeconds,
      ...(overlapTrimmedSeconds !== undefined ? { overlapTrimmedSeconds } : {})
    })

    offsetSeconds += durationSeconds
  }

  const durationSeconds = offsetSeconds

  return {
    id,
    title,
    source,
    eventFolder,
    startEpochMs: sortedGroups[0].startEpochMs,
    durationSeconds,
    thumbPath,
    segments
  }
}

/** Find a bundled sample-footage root for dev convenience. */
export async function findDefaultRoot(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if ((await exists(join(c, 'TeslaCam'))) || (await exists(join(c, 'TeslaTrackMode')))) {
      return c
    }
  }
  return null
}
