import { useEffect, useMemo, useRef, useState } from 'react'
import type { SegmentGroup } from '@shared/types'
import type { SyncEngine, SyncSnapshot } from '../sync/SyncEngine'
import { cameraLabel, mediaUrl, orderCameras } from '../lib/media'

function gridColsFor(n: number): string {
  if (n <= 1) return 'grid-cols-1'
  if (n === 2) return 'grid-cols-2'
  if (n <= 4) return 'grid-cols-2'
  return 'grid-cols-3'
}

function CameraTile({
  engine,
  camera,
  path,
  segmentOffset,
  offset,
  ended,
  presenting
}: {
  engine: SyncEngine
  camera: string
  path: string
  segmentOffset: number
  offset: number | undefined
  ended: boolean
  presenting: boolean
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  // A missing/corrupt clip must surface as an overlay, not silent black — the
  // engine keeps the playhead advancing and other cameras stay in sync.
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onErr = (): void => {
      console.error(`[camera ${camera}] media error`, el.error?.code, el.error?.message)
      setStatus('error')
    }
    const onReady = (): void => setStatus('ready')
    el.addEventListener('error', onErr)
    el.addEventListener('loadeddata', onReady)
    engine.registerVideo(camera, el, segmentOffset)
    return () => {
      el.removeEventListener('error', onErr)
      el.removeEventListener('loadeddata', onReady)
      engine.unregisterVideo(camera)
    }
  }, [engine, camera, path, segmentOffset])

  const offsetMs = offset !== undefined ? Math.round(offset * 1000) : null
  const inSync = offsetMs !== null && Math.abs(offsetMs) <= 28

  return (
    <div className="group relative overflow-hidden rounded-lg bg-black ring-1 ring-ink-700">
      <video
        ref={ref}
        src={mediaUrl(path)}
        className="h-full w-full object-contain"
        muted
        playsInline
      />
      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-700 border-t-accent-soft" />
        </div>
      )}
      {status === 'error' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ink-900">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="h-6 w-6 text-slate-500"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m0 3.75h.008M10.36 3.59 1.92 18a1.5 1.5 0 0 0 1.3 2.25h17.56a1.5 1.5 0 0 0 1.3-2.25L13.64 3.59a1.5 1.5 0 0 0-2.6 0Z"
            />
          </svg>
          <span className="text-xs font-medium text-slate-400">Clip unavailable</span>
        </div>
      )}
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-2">
        <span className="rounded bg-black/55 px-2 py-0.5 text-xs font-medium tracking-wide text-slate-100 backdrop-blur">
          {cameraLabel(camera)}
        </span>
      </div>
      {offsetMs !== null && (ended || presenting) && (
        <div className="pointer-events-none absolute right-2 top-2">
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] backdrop-blur ${
              ended
                ? 'bg-slate-600/40 text-slate-300'
                : inSync
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-amber-500/25 text-amber-200'
            }`}
            title="Offset from the camera group's average on-screen frame time"
          >
            {ended ? 'ended' : `${offsetMs >= 0 ? '+' : ''}${offsetMs} ms`}
          </span>
        </div>
      )}
    </div>
  )
}

export default function VideoGrid({
  group,
  segmentOffset,
  engine,
  snapshot
}: {
  group: SegmentGroup
  segmentOffset: number
  engine: SyncEngine
  snapshot: SyncSnapshot
}): JSX.Element {
  const cameras = useMemo(() => orderCameras(group.cameras), [group])
  const diagById = useMemo(() => {
    const m = new Map<string, { offset: number; ended: boolean; presenting: boolean }>()
    for (const c of snapshot.cameras)
      m.set(c.id, { offset: c.groupOffset, ended: c.ended, presenting: c.presenting })
    return m
  }, [snapshot])

  return (
    <div className={`grid h-full w-full gap-2 ${gridColsFor(cameras.length)}`}>
      {cameras.map((c) => {
        const d = diagById.get(c.camera)
        return (
          <CameraTile
            key={`${group.id}:${c.camera}`}
            engine={engine}
            camera={c.camera}
            path={c.path}
            segmentOffset={segmentOffset}
            offset={d?.offset}
            ended={d?.ended ?? false}
            presenting={d?.presenting ?? false}
          />
        )
      })}
    </div>
  )
}
