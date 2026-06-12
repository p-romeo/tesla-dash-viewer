// Disk-cached OSM tile serving for the tiles:// protocol handler (index.ts).
// Same pattern as media://, but cache-first with a network fallback so the map
// works where footage review actually happens (no-network garage/paddock).
// Kept electron-free (cache root + fetch are injected) so the logic is
// unit-testable, like httpRange.ts.

import { join, dirname } from 'path'
import { createReadStream } from 'fs'
import { mkdir, rename, stat, writeFile } from 'fs/promises'
import { Readable } from 'stream'

export const OSM_TILE_ORIGIN = 'https://tile.openstreetmap.org'

// OSM serves raster tiles up to z19; requesting beyond that just 404s upstream.
// MapPanel's source declares the same maxzoom so MapLibre never asks.
const MAX_ZOOM = 19

export interface TileCoord {
  z: number
  x: number
  y: number
}

/**
 * Parse and validate a `tiles://osm/{z}/{x}/{y}.png` URL. Strict validation
 * matters because the coordinates become a filesystem path — anything that
 * isn't a plain in-range integer triple is rejected (no traversal, no
 * unbounded cache keys).
 */
export function parseTileUrl(rawUrl: string): TileCoord | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'tiles:' || url.host !== 'osm') return null
  const m = /^\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname)
  if (!m) return null
  const z = Number(m[1])
  const x = Number(m[2])
  const y = Number(m[3])
  if (z > MAX_ZOOM) return null
  // A zoom level is a 2^z × 2^z grid; x/y outside it are not real tiles.
  const extent = 2 ** z
  if (x >= extent || y >= extent) return null
  return { z, x, y }
}

export function tileCachePath(cacheRoot: string, t: TileCoord): string {
  return join(cacheRoot, 'osm', String(t.z), String(t.x), `${t.y}.png`)
}

export interface TileCacheDeps {
  cacheRoot: string
  /** net.fetch in production; injected so tests can stub the network. */
  fetchImpl: (url: string, init: { headers: Record<string, string> }) => Promise<GlobalResponse>
  /** OSM tile-usage policy requires an identifying User-Agent. */
  userAgent: string
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const PNG_HEADERS = {
  'Content-Type': 'image/png',
  // The renderer page origin differs from tiles:// (http://localhost in dev,
  // file:// packaged), so fetch() needs CORS clearance on the response.
  'Access-Control-Allow-Origin': '*'
}

/**
 * Serve one tile: disk cache first, network fallback. Cache-first (rather than
 * revalidating) is deliberate — map tiles barely change, it keeps the map fully
 * usable offline once an area has been seen, and it minimizes load on the free
 * OSM servers. Only tiles the map actually requests are fetched (no prefetch),
 * which keeps us inside the OSM tile-usage policy.
 */
export async function serveTile(request: GlobalRequest, deps: TileCacheDeps): Promise<GlobalResponse> {
  const coord = parseTileUrl(request.url)
  if (!coord) return new Response('Bad tile URL', { status: 400 })

  const cachePath = tileCachePath(deps.cacheRoot, coord)
  try {
    await stat(cachePath)
    const body = Readable.toWeb(createReadStream(cachePath)) as unknown as ReadableStream<Uint8Array>
    return new Response(body, { status: 200, headers: PNG_HEADERS })
  } catch {
    // Cache miss — fall through to the network.
  }

  let upstream: GlobalResponse
  try {
    upstream = await deps.fetchImpl(`${OSM_TILE_ORIGIN}/${coord.z}/${coord.x}/${coord.y}.png`, {
      headers: { 'User-Agent': deps.userAgent }
    })
  } catch {
    // Offline and not cached: the map shows a blank tile but stays alive.
    return new Response('Tile unavailable offline', { status: 503 })
  }
  if (!upstream.ok) return new Response(null, { status: upstream.status })

  const buf = Buffer.from(await upstream.arrayBuffer())
  // A captive portal or intercepting proxy can answer 200 with an HTML page;
  // caching that would poison the tile (served as image/png forever after,
  // even offline). Trust the bytes, not the status: require the PNG signature.
  if (buf.length < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => buf[i] !== b)) {
    return new Response('Upstream payload is not a PNG', { status: 502 })
  }
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    // Write-then-rename so a crash mid-write can never leave a truncated PNG
    // that would be served as a valid cache hit forever after.
    const tmp = `${cachePath}.${process.pid}.tmp`
    await writeFile(tmp, buf)
    await rename(tmp, cachePath)
  } catch {
    // A failed cache write must not fail the tile — serve what we fetched.
  }
  return new Response(buf, { status: 200, headers: PNG_HEADERS })
}
