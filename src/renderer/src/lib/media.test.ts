import { describe, expect, it } from 'vitest'
import {
  mediaUrl,
  cameraLabel,
  orderCameras,
  timeLabel,
  clockLabel,
  humanizeReason,
  fmtTime
} from './media'

describe('mediaUrl', () => {
  it('percent-encodes the path so URL-special characters survive', () => {
    // '#' would truncate the URL at the fragment; '?' would start a query.
    const url = mediaUrl('/footage/My Drive #1/clip?.mp4')
    expect(url.startsWith('media://local/')).toBe(true)
    expect(url).not.toContain('#')
    expect(url).not.toContain('?')
    expect(url).toContain('%20')
    expect(url).toContain('%23')
    expect(url).toContain('%3F')
  })

  it('round-trips non-ASCII paths through decodeURIComponent', () => {
    const path = '/Pfad/видео/視頻.mp4'
    const encoded = mediaUrl(path).slice('media://local/'.length)
    expect(decodeURIComponent(encoded)).toBe(path)
  })
})

describe('cameraLabel', () => {
  it('labels the known angles', () => {
    expect(cameraLabel('front')).toBe('Front')
    expect(cameraLabel('back')).toBe('Rear')
    expect(cameraLabel('left_repeater')).toBe('Left Repeater')
    expect(cameraLabel('right_pillar')).toBe('Right Pillar')
  })

  it('title-cases unknown camera ids instead of failing', () => {
    expect(cameraLabel('fisheye_wide')).toBe('Fisheye Wide')
  })
})

describe('orderCameras', () => {
  it('sorts known angles by CAMERA_ORDER with unknowns appended alphabetically', () => {
    const items = ['zebra_cam', 'back', 'aux_cam', 'front', 'left_pillar'].map((camera) => ({
      camera
    }))
    expect(orderCameras(items).map((i) => i.camera)).toEqual([
      'front',
      'back',
      'left_pillar',
      'aux_cam',
      'zebra_cam'
    ])
  })

  it('returns a new array (does not mutate the input)', () => {
    const items = [{ camera: 'back' }, { camera: 'front' }]
    const out = orderCameras(items)
    expect(out).not.toBe(items)
    expect(items.map((i) => i.camera)).toEqual(['back', 'front'])
  })
})

describe('timeLabel', () => {
  it('formats a dashcam stamp (underscore date/time split, dashed time)', () => {
    expect(timeLabel('2026-06-04_17-03-32')).toBe('Jun 4, 2026 · 17:03:32')
  })

  it('formats a Track Mode stamp (dashed date, underscored time)', () => {
    expect(timeLabel('2026-06-04-17_03_32')).toBe('Jun 4, 2026 · 17:03:32')
  })

  it('passes through anything that matches neither shape', () => {
    expect(timeLabel('not-a-stamp')).toBe('not-a-stamp')
    expect(timeLabel('')).toBe('')
  })
})

describe('clockLabel', () => {
  it('formats an epoch as a local-time wall clock', () => {
    // Construct the epoch the same way the scanner does (local time), so the
    // assertion holds in any timezone.
    const epoch = new Date(2026, 5, 4, 17, 3, 32).getTime()
    expect(clockLabel(epoch)).toBe('Jun 4, 2026 · 17:03:32')
  })

  it('returns an empty string for an invalid epoch', () => {
    expect(clockLabel(NaN)).toBe('')
  })
})

describe('humanizeReason', () => {
  it('turns snake_case event reasons into Title Case', () => {
    expect(humanizeReason('user_interaction_honk')).toBe('User Interaction Honk')
    expect(humanizeReason('sentry')).toBe('Sentry')
  })
})

describe('fmtTime', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(fmtTime(0)).toBe('0:00')
    expect(fmtTime(65)).toBe('1:05')
    expect(fmtTime(600)).toBe('10:00')
  })

  it('appends milliseconds when requested', () => {
    expect(fmtTime(65.5, true)).toBe('1:05.500')
    expect(fmtTime(0, true)).toBe('0:00.000')
  })

  it('clamps negative and non-finite input to zero', () => {
    expect(fmtTime(-12)).toBe('0:00')
    expect(fmtTime(NaN)).toBe('0:00')
    expect(fmtTime(Infinity)).toBe('0:00')
  })
})
