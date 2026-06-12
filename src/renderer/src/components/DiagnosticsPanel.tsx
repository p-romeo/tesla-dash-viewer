import type { FootageSession } from '@shared/types'
import type { SyncSnapshot } from '../sync/SyncEngine'
import { cameraLabel } from '../lib/media'

/** The M1 gate readout: live per-camera visual drift from the master clock. */
export default function DiagnosticsPanel({
  snapshot,
  session
}: {
  snapshot: SyncSnapshot
  session: FootageSession | null
}): JSX.Element {
  const spreadMs = Math.round(snapshot.interCamSpread * 1000)
  // ~1.8 frames @ 36fps: tolerant of inherent frame quantization, still < 2 frames.
  const locked = spreadMs <= 50
  const overlaps = session?.segments.filter((s) => (s.overlapTrimmedSeconds ?? 0) > 0) ?? []
  const overlapTotal = overlaps.reduce((sum, s) => sum + (s.overlapTrimmedSeconds ?? 0), 0)

  return (
    <div className="flex w-64 shrink-0 flex-col gap-3 border-l border-ink-700 bg-ink-900/60 p-4">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Sync Diagnostics
        </h2>
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          Inter-camera spread = how far apart the frames actually on screen are
          from each other (via requestVideoFrameCallback). This is the gate.
        </p>
      </div>

      <div
        className={`rounded-lg p-3 ring-1 ${
          locked
            ? 'bg-emerald-500/10 ring-emerald-500/30'
            : 'bg-amber-500/10 ring-amber-500/30'
        }`}
      >
        <div className="text-[11px] uppercase tracking-wide text-slate-400">
          Inter-camera spread
        </div>
        <div
          className={`font-mono text-2xl font-semibold ${
            locked ? 'text-emerald-300' : 'text-amber-300'
          }`}
        >
          {spreadMs} ms
        </div>
        <div className="text-[11px] text-slate-400">
          {locked ? '✓ Locked (< 2 frames)' : 'Re-converging…'}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {snapshot.cameras.length === 0 && (
          <p className="text-xs text-slate-500">No cameras loaded.</p>
        )}
        {snapshot.cameras.map((c) => {
          const ms = Math.round(c.groupOffset * 1000)
          const ok = Math.abs(ms) <= 28 // ~1 frame from the group center
          const idle = !c.presenting && !c.ended
          const dotColor = c.ended
            ? 'bg-slate-500'
            : c.seeking
              ? 'bg-sky-400'
              : idle
                ? 'bg-slate-600'
                : ok
                  ? 'bg-emerald-400'
                  : 'bg-amber-400'
          return (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-md bg-ink-800/70 px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${dotColor}`} />
                <span className="text-xs text-slate-300">{cameraLabel(c.id)}</span>
              </div>
              <div className="text-right">
                {c.ended ? (
                  <div className="font-mono text-xs text-slate-500">ended</div>
                ) : idle ? (
                  <div className="font-mono text-xs text-slate-500">idle</div>
                ) : (
                  <div
                    className={`font-mono text-xs ${ok ? 'text-emerald-300' : 'text-amber-300'}`}
                  >
                    {ms >= 0 ? '+' : ''}
                    {ms} ms
                  </div>
                )}
                <div className="font-mono text-[10px] text-slate-500">
                  {c.measuredFps ? `${c.measuredFps.toFixed(1)} fps` : '—'}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {overlaps.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-500/30">
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            Segment overlap
          </div>
          <div className="font-mono text-sm font-semibold text-amber-300">
            {overlaps.length} clip{overlaps.length === 1 ? '' : 's'} ·{' '}
            {overlapTotal.toFixed(1)}s trimmed
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-slate-400">
            A clip overran the next clip&apos;s start; the overlapping tail is
            skipped so footage never plays twice.
          </div>
        </div>
      )}

      <div className="mt-auto rounded-md bg-ink-800/50 p-2.5 font-mono text-[10px] leading-relaxed text-slate-500">
        <div>master&nbsp;= {snapshot.masterTime.toFixed(3)}s</div>
        <div>rate&nbsp;&nbsp;&nbsp;= {snapshot.rate}×</div>
        <div>state&nbsp;&nbsp;= {snapshot.playing ? 'playing' : 'paused'}</div>
      </div>
    </div>
  )
}
