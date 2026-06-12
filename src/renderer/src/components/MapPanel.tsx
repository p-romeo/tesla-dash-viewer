import { useEffect, useMemo, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { StyleSpecification, GeoJSONSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FootageSession, EventMeta } from '@shared/types'
import type { SyncSnapshot } from '../sync/SyncEngine'
import type { Telemetry } from '../lib/telemetry'

// CLAUDE.md locks the map stack to MapLibre GL + OpenStreetMap (free, no API key).
// A raster-only style needs no glyphs/sprite server, so the markers below are plain
// DOM elements — no font/icon assets to bundle. Tiles are requested over the
// tiles:// scheme (M8): the main process serves them from a disk cache with a
// network fallback, so the map works offline once an area has been viewed.
// MapLibre only fetches non-http(s) schemes through addProtocol, so route
// tiles:// through plain fetch — Electron's protocol handler does the rest.
maplibregl.addProtocol('tiles', async ({ url }, abortController) => {
  // Forward MapLibre's abort signal so tiles scrolled out of view during rapid
  // map movement cancel in flight instead of completing pointlessly.
  const res = await fetch(url, { signal: abortController.signal })
  if (!res.ok) throw new Error(`tile fetch failed: ${res.status} ${url}`)
  return { data: await res.arrayBuffer() }
})

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['tiles://osm/{z}/{x}/{y}.png'],
      tileSize: 256,
      // OSM serves raster tiles up to z19; tileCache.ts rejects deeper requests.
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors'
    }
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
}

const ACCENT = '#3b82f6'

// Reject 0/0 and out-of-range coords: Tesla telemetry rows with no GPS fix read 0,
// which would otherwise drag the trace/marker to the Gulf of Guinea. Exported so the
// App's Map-toggle gate uses the same definition the trace/pin render with.
export function validCoord(lon: number, lat: number): boolean {
  return (
    isFinite(lon) && isFinite(lat) && (lon !== 0 || lat !== 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  )
}

// A moving map: the full GPS trace for Track Mode with a marker synced to playback,
// or a single event pin for SavedClips. The marker reuses telemetry.sampleAt() on the
// same lap-aware time axis as the HUD, so map and HUD stay in lockstep. It reads only
// the 20 Hz snapshot — never the sync loop.
export default function MapPanel({
  session,
  telemetry,
  event,
  snapshot
}: {
  session: FootageSession
  telemetry: Telemetry | null
  event?: EventMeta
  snapshot: SyncSnapshot
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  const loadedRef = useRef(false)

  const isTrack = session.kind === 'track'

  // Full trace, built once per telemetry object (a session's CSV is parsed once).
  const trace = useMemo<[number, number][]>(() => {
    if (!isTrack || !telemetry) return []
    const pts: [number, number][] = []
    for (const s of telemetry.samples) if (validCoord(s.lon, s.lat)) pts.push([s.lon, s.lat])
    return pts
  }, [isTrack, telemetry])

  const pin = useMemo<[number, number] | null>(() => {
    if (isTrack || event?.estLat == null || event?.estLon == null) return null
    return validCoord(event.estLon, event.estLat) ? [event.estLon, event.estLat] : null
  }, [isTrack, event])

  // Current marker position from the synced playback sample (Track Mode only).
  // Shift by the telemetry lead-in (CSV starts before the video) so the marker tracks
  // the footage in lockstep with the HUD — see FootageSession.telemetryLeadInSeconds.
  const sample =
    isTrack && telemetry
      ? telemetry.sampleAt(
          snapshot.masterTime + (session.telemetryLeadInSeconds ?? 0),
          session.durationSeconds || snapshot.duration
        )
      : null
  const sampleLon = sample?.lon
  const sampleLat = sample?.lat
  // Memoized on the coordinate primitives so the marker effect below only fires
  // when the position actually moves, not on every 20 Hz snapshot.
  const position = useMemo<[number, number] | null>(
    () =>
      sampleLon !== undefined && sampleLat !== undefined && validCoord(sampleLon, sampleLat)
        ? [sampleLon, sampleLat]
        : null,
    [sampleLon, sampleLat]
  )

  // Create the map once. Style/center/trace are applied by the effects below so a
  // session switch never tears down and rebuilds the WebGL context.
  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [0, 0],
      zoom: 1,
      attributionControl: { compact: true }
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('load', () => {
      loadedRef.current = true
      map.addSource('trace', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} }
      })
      map.addLayer({
        id: 'trace',
        type: 'line',
        source: 'trace',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ACCENT, 'line-width': 3, 'line-opacity': 0.9 }
      })
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      loadedRef.current = false
    }
  }, [])

  // Push the trace geometry and frame the route. Runs after 'load' on first mount
  // (the source doesn't exist yet) and on every later trace change.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = (): void => {
      const src = map.getSource('trace') as GeoJSONSource | undefined
      if (!src) return
      src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: trace }, properties: {} })
      if (trace.length > 0) {
        const bounds = new maplibregl.LngLatBounds(trace[0], trace[0])
        for (const p of trace) bounds.extend(p)
        map.fitBounds(bounds, { padding: 28, duration: 0, maxZoom: 17 })
      }
    }
    if (loadedRef.current) apply()
    else map.once('load', apply)
  }, [trace])

  // Center on the event pin (SavedClips have one coarse point, no trace).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !pin) return
    const apply = (): void => {
      map.jumpTo({ center: pin, zoom: 15 })
    }
    if (loadedRef.current) apply()
    else map.once('load', apply)
  }, [pin])

  // One marker, styled per mode; rebuilt only when the mode flips (track <-> pin).
  useEffect(() => {
    const el = document.createElement('div')
    el.className = isTrack ? 'tdv-track-marker' : 'tdv-pin-marker'
    // The teardrop pin's tip should sit on the coordinate; the round track dot is
    // centered on it.
    markerRef.current = new maplibregl.Marker({ element: el, anchor: isTrack ? 'center' : 'bottom' })
    return () => {
      markerRef.current?.remove()
      markerRef.current = null
    }
  }, [isTrack])

  // Move the marker to the current position (Track) or the pin (SavedClips). Hidden
  // when there's no valid location, e.g. before the first GPS fix.
  useEffect(() => {
    const map = mapRef.current
    const marker = markerRef.current
    if (!map || !marker) return
    const loc = isTrack ? position : pin
    if (loc) marker.setLngLat(loc).addTo(map)
    else marker.remove()
  }, [isTrack, position, pin])

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-10 h-48 w-72 overflow-hidden rounded-xl shadow-xl ring-1 ring-white/15">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
