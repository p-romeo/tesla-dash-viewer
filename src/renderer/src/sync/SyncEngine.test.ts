import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOMINAL_FPS, SyncEngine } from './SyncEngine'

// The engine is driven entirely by performance.now() + requestAnimationFrame, so
// a controllable clock and a manually-stepped rAF make its decision logic fully
// deterministic — no real <video> or DOM needed.

let now = 0
let rafCb: FrameRequestCallback | null = null
let rafId = 0

beforeEach(() => {
  now = 0
  rafCb = null
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCb = cb
    return ++rafId
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Advance the mocked wall clock and run the next scheduled animation frame. */
function tick(ms = 0): void {
  now += ms
  const cb = rafCb
  rafCb = null
  cb?.(now)
}

interface FakeVideo {
  muted: boolean
  playsInline: boolean
  preload: string
  currentTime: number
  duration: number
  playbackRate: number
  readyState: number
  networkState: number
  seeking: boolean
  paused: boolean
  _vfc: ((t: number, meta: VideoFrameCallbackMetadata) => void) | null
  play(): Promise<void>
  pause(): void
  addEventListener(): void
  removeEventListener(): void
  requestVideoFrameCallback(cb: (t: number, meta: VideoFrameCallbackMetadata) => void): number
  cancelVideoFrameCallback(handle: number): void
}

function fakeVideo(duration = 60): FakeVideo {
  const v: FakeVideo = {
    muted: false,
    playsInline: false,
    preload: '',
    currentTime: 0,
    duration,
    playbackRate: 1,
    readyState: 4,
    networkState: 1,
    seeking: false,
    paused: true,
    _vfc: null,
    play() {
      v.paused = false
      return Promise.resolve()
    },
    pause() {
      v.paused = true
    },
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback(cb) {
      v._vfc = cb
      return 1
    },
    cancelVideoFrameCallback() {
      v._vfc = null
    }
  }
  return v
}

function el(v: FakeVideo): HTMLVideoElement {
  return v as unknown as HTMLVideoElement
}

/** Fire the element's pending rVFC as if a frame was just composited. */
function present(v: FakeVideo, mediaTime: number, presentedFrames = 1): void {
  const cb = v._vfc
  v._vfc = null
  cb?.(now, { mediaTime, presentedFrames } as VideoFrameCallbackMetadata)
}

function makeEngine(sessionDuration = 60): SyncEngine {
  const e = new SyncEngine()
  e.setSessionDuration(sessionDuration)
  e.start()
  return e
}

describe('registerVideo', () => {
  it('configures the element for muted inline autoplay and seeks it to the playhead', () => {
    const e = makeEngine()
    e.seek(12)
    const v = fakeVideo()
    e.registerVideo('front', el(v))
    expect(v.muted).toBe(true) // required for programmatic play()
    expect(v.playsInline).toBe(true)
    expect(v.preload).toBe('auto')
    expect(v.currentTime).toBe(12)
    e.dispose()
  })

  it('resumes a video registered mid-playback (segment-boundary remount)', () => {
    const e = makeEngine()
    e.registerVideo('a', el(fakeVideo()))
    e.play()
    const late = fakeVideo()
    e.registerVideo('b', el(late))
    expect(late.paused).toBe(false) // without this, playback degrades to seek-stutter
    e.dispose()
  })
})

describe('wall-clock master', () => {
  it('advances masterTime by elapsed wall time at the current rate', () => {
    const e = makeEngine()
    e.registerVideo('a', el(fakeVideo()))
    e.play()
    tick(1000)
    expect(e.getSnapshot().masterTime).toBeCloseTo(1, 6)
    tick(2500)
    expect(e.getSnapshot().masterTime).toBeCloseTo(3.5, 6)
    e.dispose()
  })

  it('changes rate without a time jump', () => {
    const e = makeEngine()
    e.registerVideo('a', el(fakeVideo()))
    e.play()
    tick(1000)
    e.setRate(2)
    tick(500)
    expect(e.getSnapshot().masterTime).toBeCloseTo(2, 6) // 1s @ 1x + 0.5s @ 2x
    e.dispose()
  })

  it('freezes masterTime across pause and resumes from it', () => {
    const e = makeEngine()
    e.registerVideo('a', el(fakeVideo()))
    e.play()
    tick(1000)
    e.pause()
    tick(5000) // wall clock keeps moving; the playhead must not
    expect(e.getSnapshot().masterTime).toBeCloseTo(1, 6)
    e.play()
    tick(1000)
    expect(e.getSnapshot().masterTime).toBeCloseTo(2, 6)
    e.dispose()
  })
})

describe('drift correction', () => {
  function playingEngine(): { e: SyncEngine; v: FakeVideo } {
    const e = makeEngine()
    const v = fakeVideo()
    e.registerVideo('a', el(v))
    e.play()
    tick(1000) // master = 1
    return { e, v }
  }

  it('hard-seeks a video past the hard drift threshold', () => {
    const { e, v } = playingEngine()
    v.currentTime = 5 // 4s ahead of master
    tick(0)
    expect(v.currentTime).toBeCloseTo(1, 3)
    expect(v.playbackRate).toBe(1)
    e.dispose()
  })

  it('nudges playbackRate down when slightly ahead, up when slightly behind', () => {
    const { e, v } = playingEngine()
    v.currentTime = 1.1 // ahead by 0.1 (soft zone)
    tick(0)
    expect(v.currentTime).toBeCloseTo(1.1, 6) // no hard seek
    expect(v.playbackRate).toBeCloseTo(0.94, 6)
    v.currentTime = 0.9 // behind by 0.1
    tick(0)
    expect(v.playbackRate).toBeCloseTo(1.06, 6)
    e.dispose()
  })

  it('restores the exact rate inside the in-sync band', () => {
    const { e, v } = playingEngine()
    v.playbackRate = 1.06
    v.currentTime = 1.01 // within SOFT_DRIFT
    tick(0)
    expect(v.playbackRate).toBe(1)
    e.dispose()
  })

  it('scales the nudge by the transport rate', () => {
    const { e, v } = playingEngine()
    e.setRate(2)
    tick(0)
    v.currentTime = e.getSnapshot().masterTime + 0.1
    tick(0)
    expect(v.playbackRate).toBeCloseTo(2 * 0.94, 6)
    e.dispose()
  })
})

describe('transport', () => {
  it('clamps seeks to [0, duration]', () => {
    const e = makeEngine(60)
    e.registerVideo('a', el(fakeVideo()))
    e.seek(120)
    expect(e.getSnapshot().masterTime).toBe(60)
    e.seek(-5)
    expect(e.getSnapshot().masterTime).toBe(0)
    e.dispose()
  })

  it('seeks every registered video, respecting per-camera offsets', () => {
    const e = makeEngine(60)
    const a = fakeVideo()
    const b = fakeVideo()
    e.registerVideo('a', el(a), 0)
    e.registerVideo('b', el(b), 10) // segment starting 10s into the session
    e.seek(25)
    expect(a.currentTime).toBe(25)
    expect(b.currentTime).toBe(15)
    e.dispose()
  })

  it('stops at the end of the session and pauses all videos', () => {
    const e = makeEngine(60)
    const v = fakeVideo(90)
    e.registerVideo('a', el(v))
    e.play()
    tick(61_000)
    const s = e.getSnapshot()
    expect(s.playing).toBe(false)
    expect(s.masterTime).toBe(60)
    expect(v.paused).toBe(true)
    e.dispose()
  })

  it('restarts from 0 when play() is hit at the end', () => {
    const e = makeEngine(60)
    e.registerVideo('a', el(fakeVideo()))
    e.seek(60)
    e.play()
    tick(0)
    expect(e.isPlaying()).toBe(true)
    expect(e.getSnapshot().masterTime).toBeCloseTo(0, 3)
    e.dispose()
  })

  it('steps exactly one nominal frame while paused (and pauses first if playing)', () => {
    const e = makeEngine(60)
    e.registerVideo('a', el(fakeVideo()))
    e.seek(10)
    e.play()
    e.stepFrame(1)
    expect(e.isPlaying()).toBe(false)
    expect(e.getSnapshot().masterTime).toBeCloseTo(10 + 1 / NOMINAL_FPS, 6)
    e.stepFrame(-1)
    expect(e.getSnapshot().masterTime).toBeCloseTo(10, 6)
    e.dispose()
  })
})

describe('snapshot diagnostics', () => {
  it('computes interCamSpread from presented frame times of active cameras', () => {
    const e = makeEngine(60)
    const a = fakeVideo()
    const b = fakeVideo()
    e.registerVideo('a', el(a))
    e.registerVideo('b', el(b))
    e.seek(10)
    now += 16 // lastPresentWall of 0 means "no frame yet" — present at a real time
    present(a, 10.0)
    present(b, 10.04)
    const s = e.getSnapshot()
    expect(s.interCamSpread).toBeCloseTo(0.04, 6)
    const da = s.cameras.find((c) => c.id === 'a')!
    const db = s.cameras.find((c) => c.id === 'b')!
    expect(da.groupOffset).toBeCloseTo(-0.02, 6)
    expect(db.groupOffset).toBeCloseTo(0.02, 6)
    e.dispose()
  })

  it('compares cameras on the session timeline, not raw mediaTime', () => {
    const e = makeEngine(60)
    const a = fakeVideo()
    const b = fakeVideo()
    e.registerVideo('a', el(a), 0)
    e.registerVideo('b', el(b), 5)
    e.seek(10)
    now += 16
    present(a, 10.0) // session time 10.0
    present(b, 5.0) // offset 5 + mediaTime 5 = session time 10.0
    expect(e.getSnapshot().interCamSpread).toBeCloseTo(0, 6)
    e.dispose()
  })

  it('drops cameras whose rVFC has gone stale (occluded window) from the spread', () => {
    const e = makeEngine(60)
    const v = fakeVideo()
    e.registerVideo('a', el(v))
    now += 16
    present(v, 1.0)
    expect(e.getSnapshot().cameras[0].presenting).toBe(true)
    now += 200 // no frames presented for 200ms
    expect(e.getSnapshot().cameras[0].presenting).toBe(false)
    e.dispose()
  })

  it('marks a shorter camera ended once the master passes its duration', () => {
    const e = makeEngine(60)
    e.registerVideo('short', el(fakeVideo(30)))
    e.seek(45)
    expect(e.getSnapshot().cameras[0].ended).toBe(true)
    e.seek(15)
    expect(e.getSnapshot().cameras[0].ended).toBe(false)
    e.dispose()
  })
})

describe('lifecycle', () => {
  it('resumes emitting after dispose() then start() (StrictMode double-mount)', () => {
    const e = makeEngine(60)
    const onUpdate = vi.fn()
    e.setOnUpdate(onUpdate)
    e.registerVideo('a', el(fakeVideo()))
    tick(16)
    const callsBefore = onUpdate.mock.calls.length
    expect(callsBefore).toBeGreaterThan(0)

    e.dispose()
    tick(16)
    expect(onUpdate.mock.calls.length).toBe(callsBefore) // disposed: no emits

    e.start()
    tick(16)
    expect(onUpdate.mock.calls.length).toBeGreaterThan(callsBefore)
    e.dispose()
  })
})
