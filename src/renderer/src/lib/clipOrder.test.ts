import { describe, expect, it } from 'vitest'
import type { FootageSession, ScanResult, TrackSession } from '@shared/types'
import { footageSections, gallerySections, orderedNavEntries } from './clipOrder'

function footage(id: string, source: FootageSession['source']): FootageSession {
  return { id, title: id, source, startEpochMs: 0, durationSeconds: 60, segments: [] }
}

function track(id: string): TrackSession {
  return { id, timestamp: '2026-01-01-12_00_00', startEpochMs: 0, videoPath: '/laps.mp4' }
}

// Sessions deliberately interleaved by source — the scanner emits them sorted by
// time, not by section, so section ordering is entirely clipOrder's job.
function scan(): ScanResult {
  return {
    root: '/drive',
    groups: [],
    sessions: [
      footage('recent-1', 'RecentClips'),
      footage('saved-1', 'SavedClips'),
      footage('other-1', 'other'),
      footage('recent-2', 'RecentClips'),
      footage('saved-2', 'SavedClips')
    ],
    trackSessions: [track('track-1'), track('track-2')],
    cameras: [],
    events: {}
  }
}

describe('footageSections', () => {
  it('returns the canonical section order: Saved, Recent, other', () => {
    const sections = footageSections(scan())
    expect(sections.map((s) => s.source)).toEqual(['SavedClips', 'RecentClips', 'other'])
    expect(sections.map((s) => s.title)).toEqual([
      'Saved · Sentry Events',
      'Recent Drives',
      'Clips'
    ])
  })

  it('preserves scan order within each section', () => {
    const sections = footageSections(scan())
    expect(sections[0].sessions.map((s) => s.id)).toEqual(['saved-1', 'saved-2'])
    expect(sections[1].sessions.map((s) => s.id)).toEqual(['recent-1', 'recent-2'])
    expect(sections[2].sessions.map((s) => s.id)).toEqual(['other-1'])
  })

  it('keeps empty sections present (the sidebar decides visibility)', () => {
    const s = scan()
    s.sessions = []
    expect(footageSections(s)).toHaveLength(3)
    expect(footageSections(s).every((sec) => sec.sessions.length === 0)).toBe(true)
  })
})

describe('gallerySections', () => {
  it('appends a Track Mode section after the footage sections', () => {
    const sections = gallerySections(scan())
    expect(sections.map((s) => s.key)).toEqual(['SavedClips', 'RecentClips', 'other', 'track'])
    expect(sections[3].title).toBe('Track Mode')
    expect(sections[3].entries.every((e) => e.kind === 'track')).toBe(true)
  })

  it('flattens to exactly the nav order (gallery and prev/next cannot drift)', () => {
    const s = scan()
    expect(gallerySections(s).flatMap((sec) => sec.entries)).toEqual(orderedNavEntries(s))
  })
})

describe('orderedNavEntries', () => {
  it('flattens sections in display order with track sessions last', () => {
    const ids = orderedNavEntries(scan()).map((e) => e.session.id)
    expect(ids).toEqual(['saved-1', 'saved-2', 'recent-1', 'recent-2', 'other-1', 'track-1', 'track-2'])
  })

  it('tags entries with their kind for the player to dispatch on', () => {
    const entries = orderedNavEntries(scan())
    expect(entries.slice(0, 5).every((e) => e.kind === 'footage')).toBe(true)
    expect(entries.slice(5).every((e) => e.kind === 'track')).toBe(true)
  })
})
