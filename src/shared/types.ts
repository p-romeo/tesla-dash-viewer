/**
 * Types shared between the Electron main process and the renderer.
 *
 * The data model is derived from the real example footage (see NOTES.md):
 *  - TeslaCam dashcam/Sentry: up to N camera angles, ~60s segments, grouped by a
 *    shared start-timestamp; SavedClips carry an `event.json` location pin.
 *  - Track Mode: a single continuous video paired with a dense telemetry CSV.
 */

/** Canonical camera order for layout. Unknown cameras are appended after these. */
export const CAMERA_ORDER = [
  'front',
  'back',
  'left_repeater',
  'right_repeater',
  'left_pillar',
  'right_pillar'
] as const

export type KnownCamera = (typeof CAMERA_ORDER)[number]
export type CameraId = KnownCamera | string

/** One camera's file within a segment group. */
export interface CameraFile {
  camera: CameraId
  /** Absolute path on disk. */
  path: string
}

/**
 * A "segment group": all camera angles that share one start-timestamp
 * (e.g. 2026-06-04_17-03-32-{front,back,left_repeater,right_repeater}.mp4).
 * This is the atomic unit the M1 sync spike loads.
 */
export interface SegmentGroup {
  id: string
  /** Raw filename timestamp, e.g. "2026-06-04_17-03-32". */
  timestamp: string
  /** Epoch millis parsed from the timestamp (local time, no tz in the data). */
  startEpochMs: number
  source: 'RecentClips' | 'SavedClips' | 'other'
  /** For SavedClips, the event folder name. */
  eventFolder?: string
  cameras: CameraFile[]
  /** Real clip length in seconds, read from the MP4 header; undefined if unmeasurable. */
  measuredDurationSeconds?: number
}

/** A single segment group placed on the session timeline. */
export interface SessionSegment {
  group: SegmentGroup
  /** Offset in seconds from the start of the session. */
  offsetSeconds: number
  /** Duration in seconds. */
  durationSeconds: number
  /** Seconds trimmed off this clip's effective duration because the next clip
   *  starts before this one ends (a start-to-start overlap — rare in Tesla
   *  data). Without the trim the same wall-clock moment would play twice and
   *  the per-segment HUD clock would jump backwards. Absent when no overlap. */
  overlapTrimmedSeconds?: number
}

/** A logical grouping of contiguous or related segment groups. */
export interface FootageSession {
  id: string
  title: string
  source: 'RecentClips' | 'SavedClips' | 'other'
  eventFolder?: string
  startEpochMs: number
  /** Total duration in seconds. */
  durationSeconds: number
  /** 128x96 preview still Tesla writes next to the footage; undefined if absent. */
  thumbPath?: string
  segments: SessionSegment[]
  /** Recording mode driving the HUD; absence means dashcam. Track Mode is wrapped
   *  in a synthetic session (App.selectTrackSession) and sets this to 'track'. */
  kind?: 'dashcam' | 'track'
  /** Track Mode telemetry CSV path, carried through for the HUD. */
  telemetryPath?: string
  /** Seconds the telemetry recording leads the video (videoStart − telemetryStart).
   *  Tesla starts the CSV a few seconds before the laps video, so telemetry row 0 is
   *  NOT video time 0; the HUD/map shift sampleAt() by this much to stay in lockstep
   *  with the footage. Undefined/0 means no shift (e.g. dashcam, or unpaired). */
  telemetryLeadInSeconds?: number
}

/** Parsed contents of a SavedClips `event.json` sidecar. */
export interface EventMeta {
  timestamp: string
  city?: string
  estLat?: number
  estLon?: number
  reason?: string
  camera?: string
}

/** A Track Mode session: one video + (optionally) its telemetry CSV. */
export interface TrackSession {
  id: string
  timestamp: string
  startEpochMs: number
  videoPath: string
  telemetryPath?: string
  /** Epoch millis the telemetry recording started (from the CSV filename stamp).
   *  Differs from `startEpochMs` (the video start) by a few seconds; the HUD/map use
   *  the difference to align telemetry with the footage. Undefined if no CSV paired. */
  telemetryStartEpochMs?: number
  thumbPath?: string
  /** Real measured length of the single Track video, in seconds; undefined if unmeasurable. */
  durationSeconds?: number
}

/** Result of scanning a footage root directory. */
export interface ScanResult {
  root: string
  /** Dashcam/Sentry segment groups, sorted by start time ascending. */
  groups: SegmentGroup[]
  /** Dashcam/Sentry driving/event sessions, sorted by start time ascending. */
  sessions: FootageSession[]
  /** Track Mode sessions. */
  trackSessions: TrackSession[]
  /** Distinct camera angles discovered across all groups. */
  cameras: CameraId[]
  /** SavedClips event metadata, keyed by event folder name. */
  events: Record<string, EventMeta>
}

/** The API surface exposed to the renderer via the preload contextBridge. */
export interface TeslaApi {
  /** Scan a footage root and return the structured model. */
  scanDrive(root: string): Promise<ScanResult>
  /** Open a native folder picker; resolves to the chosen path or null. */
  pickFolder(): Promise<string | null>
  /** Returns the bundled sample-footage root if present (dev convenience), else null. */
  getDefaultRoot(): Promise<string | null>
  /** True when TESLA_SELFTEST=1 — runs an automated sync measurement on load. */
  selfTest: boolean
}
