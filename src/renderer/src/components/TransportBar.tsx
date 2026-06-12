import { useCallback, useState } from 'react'
import type { SyncEngine, SyncSnapshot } from '../sync/SyncEngine'
import { fmtTime } from '../lib/media'

const RATES = [0.25, 0.5, 1, 2, 4]

function IconButton({
  onClick,
  title,
  disabled,
  children
}: {
  onClick: () => void
  title: string
  disabled?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex h-9 w-9 items-center justify-center rounded-md bg-ink-700 text-slate-200 transition hover:bg-ink-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  )
}

export default function TransportBar({
  engine,
  snapshot,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  clipIndex,
  clipCount
}: {
  engine: SyncEngine
  snapshot: SyncSnapshot
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
  clipIndex: number | null
  clipCount: number
}): JSX.Element {
  const { playing, masterTime, duration, rate } = snapshot

  // While the user is actively dragging, show their value (not the 20Hz master
  // clock, which would otherwise fight the drag and make it jump back).
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubValue, setScrubValue] = useState(0)

  const onScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value)
      setScrubValue(v)
      engine.seek(v)
    },
    [engine]
  )

  const sliderValue = scrubbing ? scrubValue : Math.min(masterTime, duration || 0)

  return (
    <div className="flex items-center gap-4 border-t border-ink-700 bg-ink-900/80 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-1.5">
        <IconButton onClick={onPrev} title="Previous clip ([)" disabled={!hasPrev}>
          ⏮
        </IconButton>
        <IconButton onClick={() => engine.skip(-5)} title="Back 5s">
          «
        </IconButton>
        <IconButton onClick={() => engine.stepFrame(-1)} title="Previous frame">
          ◀|
        </IconButton>
        <button
          onClick={() => engine.toggle()}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition hover:bg-accent-soft active:scale-95"
        >
          {playing ? (
            <span className="text-lg">❚❚</span>
          ) : (
            <span className="ml-0.5 text-lg">▶</span>
          )}
        </button>
        <IconButton onClick={() => engine.stepFrame(1)} title="Next frame">
          |▶
        </IconButton>
        <IconButton onClick={() => engine.skip(5)} title="Forward 5s">
          »
        </IconButton>
        <IconButton onClick={onNext} title="Next clip (])" disabled={!hasNext}>
          ⏭
        </IconButton>
      </div>

      <div className="flex w-32 shrink-0 flex-col items-start">
        <span className="font-mono text-xs text-slate-400">
          {fmtTime(masterTime, true)} / {fmtTime(duration)}
        </span>
        {clipIndex != null && clipCount > 1 && (
          <span className="font-mono text-[10px] text-slate-600">
            clip {clipIndex} / {clipCount}
          </span>
        )}
      </div>

      <input
        type="range"
        className="scrubber flex-1"
        aria-label="Seek"
        aria-valuetext={`${fmtTime(sliderValue)} of ${fmtTime(duration)}`}
        min={0}
        max={duration || 0}
        step={0.01}
        value={sliderValue}
        onPointerDown={() => {
          setScrubValue(Math.min(masterTime, duration || 0))
          setScrubbing(true)
        }}
        onPointerUp={() => setScrubbing(false)}
        onChange={onScrub}
      />

      <div className="flex items-center gap-1 rounded-md bg-ink-800 p-1">
        {RATES.map((r) => (
          <button
            key={r}
            onClick={() => engine.setRate(r)}
            className={`rounded px-2 py-1 font-mono text-xs transition ${
              rate === r
                ? 'bg-accent text-white'
                : 'text-slate-400 hover:bg-ink-700 hover:text-slate-200'
            }`}
          >
            {r}×
          </button>
        ))}
      </div>
    </div>
  )
}
