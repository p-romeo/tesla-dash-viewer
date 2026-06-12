import { memo } from 'react'
import type { EventMeta, ScanResult, FootageSession, TrackSession } from '@shared/types'
import { cameraLabel, fmtTime, humanizeReason, mediaUrl, timeLabel } from '@renderer/lib/media'
import { footageSections } from '@renderer/lib/clipOrder'

// Shared thumbnail strip: real frame when thumbPath is set, neutral box otherwise
// (an undefined src would render a broken-image icon, so fall back explicitly).
function Thumb({ src }: { src?: string }): JSX.Element {
  if (!src) return <div className="h-10 w-16 shrink-0 rounded bg-ink-700" />
  return (
    <img
      src={mediaUrl(src)}
      alt=""
      className="h-10 w-16 shrink-0 rounded bg-ink-700 object-cover"
    />
  )
}

function ClipSection({
  title,
  sessions,
  events,
  selectedId,
  onSelect
}: {
  title: string
  sessions: FootageSession[]
  events: Record<string, EventMeta>
  selectedId: string | null
  onSelect: (s: FootageSession) => void
}): JSX.Element | null {
  if (sessions.length === 0) return null
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </h3>
        <span className="text-[11px] text-slate-600">{sessions.length}</span>
      </div>
      <div className="flex flex-col gap-1">
        {sessions.map((s) => {
          const active = s.id === selectedId
          const event = s.eventFolder ? events[s.eventFolder] : undefined
          const firstSegment = s.segments[0]?.group
          const cameras = firstSegment?.cameras || []
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s)}
              className={`flex gap-2.5 rounded-md px-2.5 py-2 text-left transition ${
                active ? 'bg-accent/20 ring-1 ring-accent/50' : 'hover:bg-ink-800'
              }`}
            >
              <Thumb src={s.thumbPath} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-200">
                    {firstSegment ? timeLabel(firstSegment.timestamp) : 'Unknown time'}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">
                    {fmtTime(s.durationSeconds)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {cameras.map((c) => (
                    <span
                      key={c.camera}
                      className="rounded bg-ink-700 px-1 py-0.5 text-[9px] text-slate-400"
                    >
                      {cameraLabel(c.camera)}
                    </span>
                  ))}
                </div>
                {event?.reason && (
                  <div className="mt-1 truncate text-[10px] text-amber-300/80">
                    {humanizeReason(event.reason)}
                    {event.city ? ` · ${event.city}` : ''}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ClipBrowser({
  scan,
  selectedId,
  onSelect,
  onSelectTrack
}: {
  scan: ScanResult
  selectedId: string | null
  onSelect: (s: FootageSession) => void
  onSelectTrack: (t: TrackSession) => void
}): JSX.Element {
  return (
    <div className="no-scrollbar w-72 shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-900/60 p-3">
      {footageSections(scan).map((section) => (
        <ClipSection
          key={section.source}
          title={section.title}
          sessions={section.sessions}
          events={scan.events}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
      {scan.trackSessions.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Track Mode
            </h3>
            <span className="text-[11px] text-slate-600">{scan.trackSessions.length}</span>
          </div>
          <div className="flex flex-col gap-1">
            {scan.trackSessions.map((t) => {
              const active = t.id === selectedId
              return (
                <button
                  key={t.id}
                  onClick={() => onSelectTrack(t)}
                  className={`flex gap-2.5 rounded-md px-2.5 py-2 text-left transition ${
                    active ? 'bg-accent/20 ring-1 ring-accent/50' : 'hover:bg-ink-800'
                  }`}
                >
                  <Thumb src={t.thumbPath} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-200">{timeLabel(t.timestamp)}</span>
                      <span className="font-mono text-[10px] text-slate-500">
                        {t.durationSeconds != null ? fmtTime(t.durationSeconds) : '—'}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="rounded bg-ink-700 px-1 py-0.5 text-[9px] text-slate-400">
                        Track
                      </span>
                      <span className="rounded bg-ink-700 px-1 py-0.5 text-[9px] text-slate-400">
                        {cameraLabel('front')}
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// Memoized: props (scan, selectedId, onSelect) only change on an actual clip
// selection, so the sidebar no longer re-renders on every 20Hz sync snapshot.
export default memo(ClipBrowser)
