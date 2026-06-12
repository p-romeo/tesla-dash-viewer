import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { parseTileUrl, tileCachePath, serveTile, OSM_TILE_ORIGIN, type TileCacheDeps } from './tileCache'

describe('parseTileUrl', () => {
  it('accepts a well-formed tile URL', () => {
    expect(parseTileUrl('tiles://osm/14/4823/6160.png')).toEqual({ z: 14, x: 4823, y: 6160 })
  })

  it('accepts the z0 root tile', () => {
    expect(parseTileUrl('tiles://osm/0/0/0.png')).toEqual({ z: 0, x: 0, y: 0 })
  })

  it('rejects other schemes and hosts', () => {
    expect(parseTileUrl('media://osm/1/0/0.png')).toBeNull()
    expect(parseTileUrl('tiles://other/1/0/0.png')).toBeNull()
  })

  it('rejects non-integer and traversal-shaped paths', () => {
    expect(parseTileUrl('tiles://osm/1/0/abc.png')).toBeNull()
    expect(parseTileUrl('tiles://osm/1/0/0.jpg')).toBeNull()
    expect(parseTileUrl('tiles://osm/1/0/0/extra.png')).toBeNull()
    expect(parseTileUrl('tiles://osm/1/-1/0.png')).toBeNull()
    expect(parseTileUrl('not a url')).toBeNull()
  })

  it('rejects zoom beyond the OSM maximum', () => {
    expect(parseTileUrl('tiles://osm/19/0/0.png')).not.toBeNull()
    expect(parseTileUrl('tiles://osm/20/0/0.png')).toBeNull()
  })

  it('rejects x/y outside the 2^z grid', () => {
    expect(parseTileUrl('tiles://osm/2/3/3.png')).not.toBeNull()
    expect(parseTileUrl('tiles://osm/2/4/0.png')).toBeNull()
    expect(parseTileUrl('tiles://osm/2/0/4.png')).toBeNull()
    expect(parseTileUrl('tiles://osm/0/0/1.png')).toBeNull()
  })
})

describe('tileCachePath', () => {
  it('maps a coordinate to a stable nested path', () => {
    expect(tileCachePath('/cache', { z: 14, x: 4823, y: 6160 })).toBe(
      join('/cache', 'osm', '14', '4823', '6160.png')
    )
  })
})

describe('serveTile', () => {
  let cacheRoot: string
  // Full 8-byte PNG signature — serveTile validates it before caching.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'tdv-tiles-'))
  })
  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true })
  })

  function deps(fetchImpl: TileCacheDeps['fetchImpl']): TileCacheDeps {
    return { cacheRoot, fetchImpl, userAgent: 'TestAgent/1' }
  }

  function req(url: string): GlobalRequest {
    return new Request(url)
  }

  it('rejects an invalid tile URL with 400 without touching the network', async () => {
    let called = false
    const res = await serveTile(
      req('tiles://osm/1/0/nope.png'),
      deps(() => {
        called = true
        return Promise.reject(new Error('unreachable'))
      })
    )
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('fetches a missing tile from upstream, serves it, and writes the cache', async () => {
    const fetched: string[] = []
    const res = await serveTile(
      req('tiles://osm/3/1/2.png'),
      deps((url, init) => {
        fetched.push(url)
        expect(init.headers['User-Agent']).toBe('TestAgent/1')
        return Promise.resolve(new Response(PNG, { status: 200 }))
      })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
    expect(fetched).toEqual([`${OSM_TILE_ORIGIN}/3/1/2.png`])
    expect(await readFile(tileCachePath(cacheRoot, { z: 3, x: 1, y: 2 }))).toEqual(PNG)
  })

  it('serves a cached tile from disk without hitting the network', async () => {
    const cachePath = tileCachePath(cacheRoot, { z: 3, x: 1, y: 2 })
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, PNG)
    let called = false
    const res = await serveTile(
      req('tiles://osm/3/1/2.png'),
      deps(() => {
        called = true
        return Promise.reject(new Error('unreachable'))
      })
    )
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
    expect(called).toBe(false)
  })

  it('returns 503 when offline and the tile is not cached', async () => {
    const res = await serveTile(
      req('tiles://osm/3/1/2.png'),
      deps(() => Promise.reject(new Error('ENOTFOUND')))
    )
    expect(res.status).toBe(503)
  })

  it('rejects a non-PNG 200 body with 502 without caching it (captive portal)', async () => {
    const res = await serveTile(
      req('tiles://osm/3/1/2.png'),
      deps(() => Promise.resolve(new Response('<html>Sign in to the network</html>', { status: 200 })))
    )
    expect(res.status).toBe(502)
    await expect(readFile(tileCachePath(cacheRoot, { z: 3, x: 1, y: 2 }))).rejects.toThrow()
  })

  it('passes an upstream error status through without caching it', async () => {
    const res = await serveTile(
      req('tiles://osm/3/1/2.png'),
      deps(() => Promise.resolve(new Response(null, { status: 404 })))
    )
    expect(res.status).toBe(404)
    await expect(readFile(tileCachePath(cacheRoot, { z: 3, x: 1, y: 2 }))).rejects.toThrow()
  })
})
