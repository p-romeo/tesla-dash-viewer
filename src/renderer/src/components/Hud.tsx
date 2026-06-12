import type { FootageSession, EventMeta, SessionSegment } from '@shared/types'
import type { SyncSnapshot } from '../sync/SyncEngine'
import type { Telemetry } from '../lib/telemetry'
import { clockLabel, humanizeReason } from '../lib/media'

const GRAVITY = 9.81 // m/s^2, to render acceleration channels as g

// The HUD is per recording mode (CLAUDE.md): Track Mode gets rich telemetry,
// dashcam/Sentry gets the frame wall-clock plus (SavedClips) the event reason.
// It reads the 20 Hz snapshot only — it never touches the sync loop.
export default function Hud({
  snapshot,
  session,
  segment,
  event,
  telemetry
}: {
  snapshot: SyncSnapshot
  session: FootageSession
  segment: SessionSegment
  event?: EventMeta
  telemetry: Telemetry | null
}): JSX.Element {
  // Per-segment wall-clock is accurate across gap-split sessions (the content
  // timeline drops dead air, so a session-wide offset would drift after a gap).
  const frameEpochMs =
    segment.group.startEpochMs + (snapshot.masterTime - segment.offsetSeconds) * 1000

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-end p-4">
      {session.kind === 'track' ? (
        <TrackHud snapshot={snapshot} session={session} telemetry={telemetry} frameEpochMs={frameEpochMs} />
      ) : (
        <DashcamHud frameEpochMs={frameEpochMs} event={event} />
      )}
    </div>
  )
}

function DashcamHud({ frameEpochMs, event }: { frameEpochMs: number; event?: EventMeta }): JSX.Element {
  return (
    <div className="w-fit rounded-lg bg-black/55 px-3 py-2 ring-1 ring-white/10 backdrop-blur">
      <div className="font-mono text-sm font-medium tracking-wide text-slate-100">
        {clockLabel(frameEpochMs)}
      </div>
      {event?.reason && (
        <div className="mt-0.5 text-xs text-slate-300">
          {humanizeReason(event.reason)}
          {event.city && <span className="text-slate-400"> · {event.city}</span>}
        </div>
      )}
    </div>
  )
}

function TrackHud({
  snapshot,
  session,
  telemetry,
  frameEpochMs
}: {
  snapshot: SyncSnapshot
  session: FootageSession
  telemetry: Telemetry | null
  frameEpochMs: number
}): JSX.Element {
  // No useMemo: masterTime changes every snapshot (the only reason this re-renders),
  // so a memo keyed on it never hits, and sampleAt is O(1) index math regardless.
  // Shift by the telemetry lead-in so stats track the footage (the CSV starts a few
  // seconds before the video) — see FootageSession.telemetryLeadInSeconds.
  const sample =
    telemetry?.sampleAt(
      snapshot.masterTime + (session.telemetryLeadInSeconds ?? 0),
      session.durationSeconds || snapshot.duration
    ) ?? null

  return (
    <div className="w-fit max-w-md rounded-xl bg-black/55 p-4 ring-1 ring-white/10 backdrop-blur">
      <div className="flex items-end gap-5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-5xl font-semibold leading-none text-slate-50">
            {sample ? Math.round(sample.speedMph) : '—'}
          </span>
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">mph</span>
        </div>
        {sample && (
          <div className="flex min-w-[8rem] flex-1 flex-col gap-1.5 pb-1">
            <Bar label="Throttle" frac={sample.throttlePct / 100} className="bg-emerald-400" />
            {/* Brake is a pressure (bar), not a 0–100% channel, so normalize against
                the session's peak braking rather than an arbitrary /100. */}
            <Bar
              label="Brake"
              frac={telemetry && telemetry.maxBrakeBar > 0 ? sample.brakeBar / telemetry.maxBrakeBar : 0}
              className="bg-red-400"
            />
          </div>
        )}
      </div>

      {sample && (
        <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1.5">
          <Stat label="Steering" value={`${Math.round(sample.steeringDeg)}°`} />
          <Stat label="Lat G" value={`${(sample.latAccel / GRAVITY).toFixed(2)}`} />
          <Stat label="Long G" value={`${(sample.lonAccel / GRAVITY).toFixed(2)}`} />
          <Stat label="Power" value={`${Math.round(sample.powerKw)} kW`} />
          <Stat label="Charge" value={`${Math.round(sample.socPct)}%`} />
          <Stat label="Lap" value={`${Math.round(sample.lap)}`} />
        </div>
      )}

      <div className="mt-3 font-mono text-[11px] tracking-wide text-slate-400">
        {clockLabel(frameEpochMs)}
      </div>
    </div>
  )
}

function Bar({ label, frac, className }: { label: string; frac: number; className: string }): JSX.Element {
  const pct = Math.min(100, Math.max(0, frac * 100))
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${className}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-mono text-sm font-medium text-slate-100">{value}</div>
    </div>
  )
}
