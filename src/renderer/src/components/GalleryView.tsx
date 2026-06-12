import { memo } from 'react'
import type { EventMeta, ScanResult, FootageSession, TrackSession } from '@shared/types'
import { cameraLabel, fmtTime, humanizeReason, mediaUrl, timeLabel } from '@renderer/lib/media'
import { gallerySections, type NavEntry } from '@renderer/lib/clipOrder'

// Full-window thumbnail gallery (M8) — an alternative entry point to the
// sidebar. Same scan data, same canonical ordering (clipOrder.ts), just laid
// out as a browsable grid of the thumb.png frames Tesla writes to the drive.

function CardThumb({ src }: { src?: string }): JSX.Element {
  if (!src) {
    return (
      <div className="flex aspect-video w-full items-center justify-center bg-ink-800 text-2xl text-slate-600">
        ▦
      </div>
    )
  }
  // lazy: a real drive can hold hundreds of cards; only decode what scrolls
  // into view instead of slamming media:// with every thumb at once.
  return (
    <img
      src={mediaUrl(src)}
      alt=""
      loading="lazy"
      className="aspect-video w-full bg-ink-800 object-cover"
    />
  )
}

function GalleryCard({
  entry,
  events,
  active,
  onPick
}: {
  entry: NavEntry
  events: Record<string, EventMeta>
  active: boolean
  onPick: (entry: NavEntry) => void
}): JSX.Element {
  const s = entry.session
  const isTrack = entry.kind === 'track'
  const timestamp = isTrack
    ? (s as TrackSession).timestamp
    : (s as FootageSession).segments[0]?.group.timestamp
  const duration = s.durationSeconds
  const cameras = isTrack ? null : ((s as FootageSession).segments[0]?.group.cameras ?? [])
  const event =
    !isTrack && (s as FootageSession).eventFolder
      ? events[(s as FootageSession).eventFolder as string]
      : undefined
  return (
    <button
      onClick={() => onPick(entry)}
      className={`flex flex-col overflow-hidden rounded-lg text-left ring-1 transition ${
        active
          ? 'bg-accent/10 ring-accent/60'
          : 'bg-ink-900 ring-ink-700 hover:bg-ink-850 hover:ring-ink-600'
      }`}
    >
      <CardThumb src={s.thumbPath} />
      <div className="flex flex-col gap-1 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-slate-200">
            {timestamp ? timeLabel(timestamp) : 'Unknown time'}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-slate-500">
            {duration != null ? fmtTime(duration) : '—'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {isTrack ? (
            <>
              <span className="rounded bg-ink-700 px-1 py-0.5 text-[9px] text-slate-400">Track</span>
              <span className="rounded bg-ink-700 px-1 py-0.5 text-[9px] text-slate-400">
                {cameraLabel('front')}
              </span>
            </>
          ) : (
            cameras?.map((c) => (
              <span
                key={c.camera}
                className="rounded bg-ink-700 px-1 py-0.5 text-[9px] text-slate-400"
              >
                {cameraLabel(c.camera)}
              </span>
            ))
          )}
        </div>
        {event?.reason && (
          <div className="truncate text-[10px] text-amber-300/80">
            {humanizeReason(event.reason)}
            {event.city ? ` · ${event.city}` : ''}
          </div>
        )}
      </div>
    </button>
  )
}

function GalleryView({
  scan,
  selectedId,
  onPick,
  onClose
}: {
  scan: ScanResult
  selectedId: string | null
  onPick: (entry: NavEntry) => void
  onClose: () => void
}): JSX.Element {
  const sections = gallerySections(scan).filter((sec) => sec.entries.length > 0)
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-ink-950">
      <div className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-slate-100">Library</h2>
          <span className="text-[11px] text-slate-500">
            {sections.reduce((n, sec) => n + sec.entries.length, 0)} clips
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close gallery"
          className="flex h-7 w-7 items-center justify-center rounded-md bg-ink-700 text-xs text-slate-200 transition hover:bg-ink-600"
        >
          ✕
        </button>
      </div>
      <div className="no-scrollbar flex-1 overflow-y-auto px-6 py-5">
        {sections.map((sec) => (
          <section key={sec.key} className="mb-8">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {sec.title}
              </h3>
              <span className="text-[11px] text-slate-600">{sec.entries.length}</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {sec.entries.map((entry) => (
                <GalleryCard
                  key={entry.session.id}
                  entry={entry}
                  events={scan.events}
                  active={entry.session.id === selectedId}
                  onPick={onPick}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

// Memoized like ClipBrowser: only mounted while open, but props otherwise only
// change on scan/selection — never on the 20 Hz sync snapshot.
export default memo(GalleryView)
