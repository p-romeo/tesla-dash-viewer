import { CAMERA_ORDER, type CameraId } from '@shared/types'

/** Build a `media://` URL the privileged protocol handler can stream from disk. */
export function mediaUrl(absPath: string): string {
  return `media://local/${encodeURIComponent(absPath)}`
}

/** snake_case -> Title Case, e.g. "user_interaction_honk" -> "User Interaction Honk". */
function titleCase(s: string): string {
  return s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Human-friendly label for a camera id. */
export function cameraLabel(camera: CameraId): string {
  switch (camera) {
    case 'front':
      return 'Front'
    case 'back':
      return 'Rear'
    case 'left_repeater':
      return 'Left Repeater'
    case 'right_repeater':
      return 'Right Repeater'
    case 'left_pillar':
      return 'Left Pillar'
    case 'right_pillar':
      return 'Right Pillar'
    default:
      return titleCase(camera)
  }
}

/** Stable camera ordering for grid layout (known angles first). */
export function orderCameras<T extends { camera: CameraId }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ia = CAMERA_ORDER.indexOf(a.camera as never)
    const ib = CAMERA_ORDER.indexOf(b.camera as never)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.camera.localeCompare(b.camera)
  })
}

/** Format a Tesla filename timestamp as "Jun 4, 2026 · 17:03:32".
 *  Dashcam stamps are "YYYY-MM-DD_HH-MM-SS"; Track stamps are "YYYY-MM-DD-HH_MM_SS"
 *  — the `[_-]` classes accept either separator set. Returns the raw input if it
 *  matches neither. */
export function timeLabel(ts: string): string {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})$/)
  if (!m) return ts
  const [, y, mo, d, hh, mm, ss] = m
  const month = new Date(+y, +mo - 1, +d).toLocaleString('en-US', { month: 'short' })
  return `${month} ${+d}, ${y} · ${hh}:${mm}:${ss}`
}

// Cached once — clockLabel runs every 20 Hz HUD frame, and constructing an Intl
// formatter per call is the expensive part.
const CLOCK_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})
const CLOCK_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

/** Wall-clock label for the HUD, e.g. "Jun 4, 2026 · 17:03:32". Tesla stamps
 *  carry no timezone, so epochMs is treated as local time. */
export function clockLabel(epochMs: number): string {
  const d = new Date(epochMs)
  if (isNaN(d.getTime())) return ''
  return `${CLOCK_DATE_FMT.format(d)} · ${CLOCK_TIME_FMT.format(d)}`
}

/** snake_case event reason -> Title Case, e.g. "user_interaction_honk" ->
 *  "User Interaction Honk". */
export function humanizeReason(reason: string): string {
  return titleCase(reason)
}

/** Format seconds as M:SS.mmm (millisecond precision, for the sync HUD). */
export function fmtTime(seconds: number, withMs = false): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const base = `${m}:${s.toString().padStart(2, '0')}`
  if (!withMs) return base
  const ms = Math.floor((seconds % 1) * 1000)
  return `${base}.${ms.toString().padStart(3, '0')}`
}
