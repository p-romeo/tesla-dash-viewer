import type { ScanResult, FootageSession, TrackSession } from '@shared/types'

// Single source of truth for clip ordering, shared by the sidebar (ClipBrowser),
// the full-window gallery (GalleryView), and prev/next navigation (App). All
// derive from here so the visible lists and the navigation order cannot
// silently drift apart.

export type NavEntry =
  | { kind: 'footage'; session: FootageSession }
  | { kind: 'track'; session: TrackSession }

export interface FootageSection {
  source: FootageSession['source']
  title: string
  sessions: FootageSession[]
}

// The canonical footage section order + titles; track sessions always follow.
const SECTION_ORDER: { source: FootageSession['source']; title: string }[] = [
  { source: 'SavedClips', title: 'Saved · Sentry Events' },
  { source: 'RecentClips', title: 'Recent Drives' },
  { source: 'other', title: 'Clips' }
]

export function footageSections(scan: ScanResult): FootageSection[] {
  return SECTION_ORDER.map(({ source, title }) => ({
    source,
    title,
    sessions: scan.sessions.filter((s) => s.source === source)
  }))
}

export interface GallerySection {
  key: string
  title: string
  entries: NavEntry[]
}

// Every section (footage + Track Mode) as NavEntry lists, in display order.
// The gallery renders these directly; nav order is the flattening below.
export function gallerySections(scan: ScanResult): GallerySection[] {
  const sections: GallerySection[] = footageSections(scan).map((sec) => ({
    key: sec.source,
    title: sec.title,
    entries: sec.sessions.map((s) => ({ kind: 'footage' as const, session: s }))
  }))
  sections.push({
    key: 'track',
    title: 'Track Mode',
    entries: scan.trackSessions.map((t) => ({ kind: 'track' as const, session: t }))
  })
  return sections
}

// Flat ordered list matching the sidebar's and gallery's top-to-bottom order.
export function orderedNavEntries(scan: ScanResult): NavEntry[] {
  return gallerySections(scan).flatMap((sec) => sec.entries)
}
