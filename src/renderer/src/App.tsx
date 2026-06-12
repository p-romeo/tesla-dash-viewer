import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ScanResult, FootageSession, TrackSession, SegmentGroup } from '@shared/types'
import { mediaUrl, timeLabel } from './lib/media'
import { orderedNavEntries, type NavEntry } from './lib/clipOrder'
import { parseTelemetry, type Telemetry } from './lib/telemetry'
import { useSyncEngine } from './sync/useSyncEngine'
import { runSelfTest } from './sync/selftest'
import VideoGrid from './components/VideoGrid'
import TransportBar from './components/TransportBar'
import DiagnosticsPanel from './components/DiagnosticsPanel'
import ClipBrowser from './components/ClipBrowser'
import Hud from './components/Hud'
import MapPanel, { validCoord } from './components/MapPanel'
import ShortcutsOverlay from './components/ShortcutsOverlay'
import GalleryView from './components/GalleryView'

export default function App(): JSX.Element {
  const { engine, snapshot } = useSyncEngine()
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [selectedSession, setSelectedSession] = useState<FootageSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showHud, setShowHud] = useState(true)
  const [showMap, setShowMap] = useState(true)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null)

  const selectSession = useCallback(
    (s: FootageSession) => {
      engine.pause()
      engine.seek(0)
      engine.setSessionDuration(s.durationSeconds)
      setSelectedSession(s)
    },
    [engine]
  )

  // Track Mode is front-cam only with no multi-segment grouping, so we wrap it in
  // a synthetic single-segment FootageSession to reuse the dashcam playback path.
  // id === t.id keeps ClipBrowser's selectedId highlighting working for both kinds.
  const selectTrackSession = useCallback(
    (t: TrackSession) => {
      // When the length is unmeasurable, pass 0: the SyncEngine falls back to the
      // real video.duration it reads on loadedmetadata (sessionDuration || duration),
      // so the scrubber self-corrects once the clip loads — no bogus fixed span.
      const duration = t.durationSeconds ?? 0
      const group: SegmentGroup = {
        id: t.id,
        timestamp: t.timestamp,
        startEpochMs: t.startEpochMs,
        source: 'other',
        cameras: [{ camera: 'front', path: t.videoPath }]
      }
      // Telemetry starts a few seconds before the video (CSV vs laps filename stamp).
      // The HUD/map sample at masterTime + this lead-in so stats track the footage.
      const telemetryLeadInSeconds =
        t.telemetryStartEpochMs != null ? (t.startEpochMs - t.telemetryStartEpochMs) / 1000 : 0
      const session: FootageSession = {
        id: t.id,
        title: timeLabel(t.timestamp),
        source: 'other',
        startEpochMs: t.startEpochMs,
        durationSeconds: duration,
        segments: [{ group, offsetSeconds: 0, durationSeconds: duration }],
        kind: 'track',
        telemetryPath: t.telemetryPath,
        telemetryLeadInSeconds
      }
      selectSession(session)
    },
    [selectSession]
  )

  const loadRoot = useCallback(
    async (root: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = await window.teslaApi.scanDrive(root)
        setScan(result)
        // Prefer the session with the most camera angles to best exercise sync.
        const best = [...result.sessions].sort(
          (a, b) => (b.segments[0]?.group.cameras.length ?? 0) - (a.segments[0]?.group.cameras.length ?? 0)
        )[0]
        // A folder can hold only Track Mode footage (no dashcam sessions); fall
        // back to its first track session so those clips stay reachable.
        if (best) selectSession(best)
        else if (result.trackSessions[0]) selectTrackSession(result.trackSessions[0])
        else setError('No playable footage found in that folder.')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [selectSession, selectTrackSession]
  )

  const pickFolder = useCallback(async () => {
    const root = await window.teslaApi.pickFolder()
    if (root) void loadRoot(root)
  }, [loadRoot])

  // On launch, auto-load bundled sample footage if present (dev convenience).
  useEffect(() => {
    void (async () => {
      const root = await window.teslaApi.getDefaultRoot()
      if (root) void loadRoot(root)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Automated headless sync self-test (TESLA_SELFTEST=1).
  useEffect(() => {
    if (selectedSession && window.teslaApi.selfTest) void runSelfTest(engine)
  }, [selectedSession, engine])

  // Helper to find the active segment inside selectedSession based on snapshot.masterTime
  const activeSegment = useMemo(() => {
    if (!selectedSession || selectedSession.segments.length === 0) return null
    const segments = selectedSession.segments
    const masterTime = snapshot.masterTime

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const next = segments[i + 1]
      if (masterTime >= seg.offsetSeconds && masterTime < next.offsetSeconds) {
        return seg
      }
    }
    return segments[segments.length - 1]
  }, [selectedSession, snapshot.masterTime])

  // Track Mode telemetry for the HUD. The CSV streams over media:// (text/csv,
  // supportFetchAPI) and is parsed in the renderer — no disk access, no new IPC.
  const telemetryPath = selectedSession?.telemetryPath
  useEffect(() => {
    // Clear synchronously so a fast session switch never renders the previous
    // session's telemetry over the new video while the new CSV is still being
    // fetched — a deliberate reset-on-key-change, not a cascading-render bug.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTelemetry(null)
    if (!telemetryPath) return
    let cancelled = false
    void (async () => {
      try {
        const text = await (await fetch(mediaUrl(telemetryPath))).text()
        if (!cancelled) setTelemetry(parseTelemetry(text))
      } catch {
        if (!cancelled) setTelemetry(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [telemetryPath])

  const eventMeta =
    selectedSession?.eventFolder && scan ? scan.events[selectedSession.eventFolder] : undefined

  // The map only has something to show in Track Mode (dense GPS trace) or for a
  // SavedClips event (one coarse pin). RecentClips carry no location at all — a
  // property of the data, not a bug — so the Map toggle is disabled for them.
  const hasLocation = useMemo(() => {
    if (!selectedSession) return false
    if (selectedSession.kind === 'track') {
      return !!telemetry && telemetry.samples.some((s) => validCoord(s.lon, s.lat))
    }
    return eventMeta?.estLat != null && eventMeta?.estLon != null
      ? validCoord(eventMeta.estLon, eventMeta.estLat)
      : false
  }, [selectedSession, telemetry, eventMeta])

  // Flat ordered list of all sessions (matching ClipBrowser display order) for prev/next navigation.
  const orderedSessions = useMemo(() => (scan ? orderedNavEntries(scan) : []), [scan])

  const currentNavIndex = useMemo(() => {
    if (!selectedSession) return -1
    return orderedSessions.findIndex((e) =>
      e.kind === 'track'
        ? selectedSession.kind === 'track' && e.session.id === selectedSession.id
        : selectedSession.kind !== 'track' && e.session.id === selectedSession.id
    )
  }, [orderedSessions, selectedSession])

  const hasPrev = currentNavIndex > 0
  const hasNext = currentNavIndex >= 0 && currentNavIndex < orderedSessions.length - 1

  const goToNavIndex = useCallback(
    (index: number) => {
      const entry = orderedSessions[index]
      if (!entry) return
      if (entry.kind === 'footage') selectSession(entry.session)
      else selectTrackSession(entry.session)
    },
    [orderedSessions, selectSession, selectTrackSession]
  )

  // Gallery picks dispatch on kind and close the overlay — selecting a clip is
  // the act of leaving the gallery for the player.
  const pickFromGallery = useCallback(
    (entry: NavEntry) => {
      if (entry.kind === 'footage') selectSession(entry.session)
      else selectTrackSession(entry.session)
      setShowGallery(false)
    },
    [selectSession, selectTrackSession]
  )

  const goPrev = useCallback(() => {
    if (hasPrev) goToNavIndex(currentNavIndex - 1)
  }, [hasPrev, currentNavIndex, goToNavIndex])

  const goNext = useCallback(() => {
    if (hasNext) goToNavIndex(currentNavIndex + 1)
  }, [hasNext, currentNavIndex, goToNavIndex])

  // Keyboard transport shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Help + dismiss work with or without a loaded session.
      if (e.key === '?') {
        setShowShortcuts((v) => !v)
        return
      }
      if (e.key === 'Escape') {
        // Dismiss the topmost layer only: shortcuts (z-50) over gallery (z-40).
        if (showShortcuts) setShowShortcuts(false)
        else setShowGallery(false)
        return
      }
      // The gallery needs a scan, not a selected session — it must stay
      // reachable when nothing is playing (e.g. a fresh folder open).
      if (e.key === 'g' && scan) {
        setShowGallery((v) => !v)
        return
      }
      if (!selectedSession) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          engine.toggle()
          break
        case 'ArrowLeft':
          engine.skip(e.shiftKey ? -1 : -5)
          break
        case 'ArrowRight':
          engine.skip(e.shiftKey ? 1 : 5)
          break
        case ',':
          engine.stepFrame(-1)
          break
        case '.':
          engine.stepFrame(1)
          break
        case '[':
          goPrev()
          break
        case ']':
          goNext()
          break
        case 'd':
          setShowDiagnostics((v) => !v)
          break
        case 'h':
          setShowHud((v) => !v)
          break
        case 'm':
          setShowMap((v) => !v)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, goPrev, goNext, selectedSession, scan, showShortcuts])

  return (
    <div className="relative flex h-screen flex-col bg-ink-950">
      {/* Title bar */}
      <header className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/20 text-accent-soft">
            <span className="text-sm">▦</span>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-slate-100">Tesla Dash Viewer</h1>
            <p className="text-[10px] text-slate-500">
              Multi-camera playback
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {scan && (
            <span className="max-w-md truncate text-[11px] text-slate-500" title={scan.root}>
              {scan.root}
            </span>
          )}
          <button
            onClick={() => setShowGallery((v) => !v)}
            disabled={!scan}
            aria-pressed={showGallery}
            title={scan ? 'Browse all clips (g)' : 'Open a footage folder first'}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              !scan
                ? 'cursor-not-allowed bg-ink-800 text-slate-600'
                : showGallery
                  ? 'bg-accent/20 text-accent-soft ring-1 ring-accent/50'
                  : 'bg-ink-700 text-slate-200 hover:bg-ink-600'
            }`}
          >
            Gallery
          </button>
          <button
            onClick={() => setShowHud((v) => !v)}
            aria-pressed={showHud}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              showHud
                ? 'bg-accent/20 text-accent-soft ring-1 ring-accent/50'
                : 'bg-ink-700 text-slate-200 hover:bg-ink-600'
            }`}
          >
            HUD
          </button>
          <button
            onClick={() => setShowMap((v) => !v)}
            disabled={!hasLocation}
            aria-pressed={showMap && hasLocation}
            title={hasLocation ? undefined : 'No GPS data for this clip'}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              !hasLocation
                ? 'cursor-not-allowed bg-ink-800 text-slate-600'
                : showMap
                  ? 'bg-accent/20 text-accent-soft ring-1 ring-accent/50'
                  : 'bg-ink-700 text-slate-200 hover:bg-ink-600'
            }`}
          >
            Map
          </button>
          <button
            onClick={() => setShowDiagnostics((v) => !v)}
            aria-pressed={showDiagnostics}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              showDiagnostics
                ? 'bg-accent/20 text-accent-soft ring-1 ring-accent/50'
                : 'bg-ink-700 text-slate-200 hover:bg-ink-600'
            }`}
          >
            Diagnostics
          </button>
          <button
            onClick={() => setShowShortcuts((v) => !v)}
            aria-pressed={showShortcuts}
            title="Keyboard shortcuts (?)"
            className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-medium transition ${
              showShortcuts
                ? 'bg-accent/20 text-accent-soft ring-1 ring-accent/50'
                : 'bg-ink-700 text-slate-200 hover:bg-ink-600'
            }`}
          >
            ?
          </button>
          <button
            onClick={pickFolder}
            className="rounded-md bg-ink-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-ink-600"
          >
            Open footage folder…
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {scan && (scan.sessions.length > 0 || scan.trackSessions.length > 0) && (
          <ClipBrowser
            scan={scan}
            selectedId={selectedSession?.id ?? null}
            onSelect={selectSession}
            onSelectTrack={selectTrackSession}
          />
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center p-3">
            {selectedSession && activeSegment ? (
              <div className="relative flex h-full w-full items-center justify-center">
                <VideoGrid
                  group={activeSegment.group}
                  segmentOffset={activeSegment.offsetSeconds}
                  engine={engine}
                  snapshot={snapshot}
                />
                {showHud && (
                  <Hud
                    snapshot={snapshot}
                    session={selectedSession}
                    segment={activeSegment}
                    event={eventMeta}
                    telemetry={telemetry}
                  />
                )}
                {showMap && hasLocation && (
                  <MapPanel
                    session={selectedSession}
                    telemetry={telemetry}
                    event={eventMeta}
                    snapshot={snapshot}
                  />
                )}
              </div>
            ) : (
              <EmptyState loading={loading} error={error} onPick={pickFolder} />
            )}
          </div>
          {selectedSession && (
            <TransportBar
              engine={engine}
              snapshot={snapshot}
              onPrev={goPrev}
              onNext={goNext}
              hasPrev={hasPrev}
              hasNext={hasNext}
              clipIndex={currentNavIndex >= 0 ? currentNavIndex + 1 : null}
              clipCount={orderedSessions.length}
            />
          )}
        </main>

        {selectedSession && showDiagnostics && (
          <DiagnosticsPanel snapshot={snapshot} session={selectedSession} />
        )}
      </div>

      {showGallery && scan && (
        <GalleryView
          scan={scan}
          selectedId={selectedSession?.id ?? null}
          onPick={pickFromGallery}
          onClose={() => setShowGallery(false)}
        />
      )}

      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}

function EmptyState({
  loading,
  error,
  onPick
}: {
  loading: boolean
  error: string | null
  onPick: () => void
}): JSX.Element {
  return (
    <div className="flex max-w-md flex-col items-center gap-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-ink-800 text-3xl text-slate-600">
        ▦
      </div>
      <div>
        <h2 className="text-lg font-semibold text-slate-200">
          {loading ? 'Scanning footage…' : 'No footage loaded'}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {loading
            ? 'Reading the drive and grouping camera angles by timestamp.'
            : 'Open a TeslaCam folder (or a folder of dashcam clips) to begin.'}
        </p>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </div>
      {!loading && (
        <button
          onClick={onPick}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-soft"
        >
          Open footage folder…
        </button>
      )}
    </div>
  )
}
