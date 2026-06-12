/**
 * SyncEngine — keeps N <video> elements locked to a single logical playhead.
 *
 * Why a wall-clock master (not "follow camera 0"):
 *  - Tesla clips report a bogus container frame rate and each camera's duration
 *    differs slightly, so frame-index sync is impossible. We drive everything by
 *    time. A real-time wall clock is robust to any single video stalling.
 *
 * Correction model per camera, every animation frame while playing:
 *   drift = video.currentTime - masterTime
 *     |drift| > HARD  -> hard seek (video.currentTime = masterTime)
 *     |drift| > SOFT  -> nudge playbackRate up/down to ease back smoothly
 *     else            -> playbackRate = rate (exact)
 *
 * Diagnostics use requestVideoFrameCallback to read each camera's actually-
 * presented frame time (mediaTime) — the true measure of on-screen sync.
 */

export interface CameraDiag {
  id: string
  /** control drift: video.currentTime - masterTime (seconds) */
  drift: number
  /** visual drift vs the continuous master: mediaTime - masterTime (seconds).
   *  Carries a systematic ~half-frame bias (mediaTime is quantized to the last
   *  presented frame); for on-screen sync prefer `groupOffset`. */
  trueDrift: number
  /** this camera's presented frame time minus the group mean (seconds).
   *  Bias-free per-camera sync indicator — 0 means perfectly with the pack. */
  groupOffset: number
  /** last presented frame time from requestVideoFrameCallback (seconds) */
  mediaTime: number
  duration: number
  ready: boolean
  /** whether the element is mid-seek */
  seeking: boolean
  /** master has passed this camera's (shorter) duration; it holds its last frame */
  ended: boolean
  /** a frame was presented (rVFC fired) within the last ~100ms — i.e. the camera
   *  is actively compositing. False when the window is occluded/hidden, which
   *  freezes rVFC and would otherwise make `mediaTime` stale. */
  presenting: boolean
  /** measured display fps (from rVFC frame deltas) */
  measuredFps: number
}

export interface SyncSnapshot {
  playing: boolean
  masterTime: number
  duration: number
  rate: number
  cameras: CameraDiag[]
  /** HEADLINE metric: max-min of presented frame times across active cameras —
   *  i.e. how far apart the cameras are *from each other* on screen. This is the
   *  real gate ("all cameras within ~1 frame"), free of the continuous-vs-
   *  quantized bias that inflates `maxAbsTrueDrift`. */
  interCamSpread: number
  /** worst |trueDrift| across active cameras (carries the quantization bias) */
  maxAbsTrueDrift: number
}

interface Tracked {
  id: string
  el: HTMLVideoElement
  offset: number
  rvfcHandle: number
  mediaTime: number
  prevMediaTime: number
  prevPresentTs: number
  presentedFrames: number
  prevPresentedFrames: number
  measuredFps: number
  /** performance.now() of the last presented frame (rVFC). 0 = none yet. */
  lastPresentWall: number
  onLoaded: () => void
}

const SOFT_DRIFT = 0.033 // ~1.2 frames @ 36fps — start nudging
const HARD_DRIFT = 0.3 // hard re-seek threshold
const NUDGE = 0.06 // ±6% playback-rate trim while correcting
/** Assumed nominal frame rate for frame-stepping (container fps is unreliable). */
export const NOMINAL_FPS = 36
const FRAME = 1 / NOMINAL_FPS

export class SyncEngine {
  private tracked = new Map<string, Tracked>()
  private playing = false
  private rate = 1
  private masterTime = 0
  private duration = 0
  private sessionDuration = 0
  private anchorWall = 0
  private anchorMedia = 0
  private raf = 0
  private disposed = false
  private onUpdate?: (s: SyncSnapshot) => void

  setOnUpdate(cb: (s: SyncSnapshot) => void): void {
    this.onUpdate = cb
  }

  setSessionDuration(duration: number): void {
    this.sessionDuration = duration
  }

  /**
   * (Re)activate the engine: clear the disposed flag and (re)start the rAF loop.
   * Required because React StrictMode (dev) mounts effects twice — mount, clean
   * up (which calls dispose()), then mount again. Without this the engine would
   * stay permanently disposed after the throwaway first mount and never emit
   * snapshots, freezing the UI.
   */
  start(): void {
    this.disposed = false
    if (this.raf === 0) this.loop()
  }

  registerVideo(id: string, el: HTMLVideoElement, offset = 0): void {
    this.unregisterVideo(id)
    el.muted = true // no audio in Tesla footage; required for programmatic play
    el.playsInline = true
    el.preload = 'auto'

    const t: Tracked = {
      id,
      el,
      offset,
      rvfcHandle: 0,
      mediaTime: 0,
      prevMediaTime: 0,
      prevPresentTs: 0,
      presentedFrames: 0,
      prevPresentedFrames: 0,
      measuredFps: 0,
      lastPresentWall: 0,
      onLoaded: () => this.recomputeDuration()
    }
    el.addEventListener('loadedmetadata', t.onLoaded)
    el.addEventListener('durationchange', t.onLoaded)

    const step = (now: number, meta: VideoFrameCallbackMetadata): void => {
      t.mediaTime = meta.mediaTime
      t.lastPresentWall = now
      t.presentedFrames = meta.presentedFrames
      if (t.prevPresentTs > 0) {
        const dt = (now - t.prevPresentTs) / 1000
        const df = meta.presentedFrames - t.prevPresentedFrames
        if (dt > 0 && df > 0) {
          const fps = df / dt
          // smooth a little
          t.measuredFps = t.measuredFps ? t.measuredFps * 0.8 + fps * 0.2 : fps
        }
      }
      t.prevPresentTs = now
      t.prevPresentedFrames = meta.presentedFrames
      t.prevMediaTime = meta.mediaTime
      if (!this.disposed) t.rvfcHandle = el.requestVideoFrameCallback(step)
    }
    t.rvfcHandle = el.requestVideoFrameCallback(step)

    this.tracked.set(id, t)
    this.recomputeDuration()
    // Seek freshly-added videos to the current playhead.
    this.applySeek(t, this.masterTime)
    // Crossing a segment boundary remounts the camera tiles while the engine is
    // still playing. registerVideo() must resume the new element itself —
    // otherwise it stays paused and the rAF loop only hard-seeks it every
    // HARD_DRIFT, turning continuous playback into a ~3fps slideshow.
    if (this.playing) void t.el.play().catch(() => {})
    if (this.raf === 0) this.loop()
  }

  unregisterVideo(id: string): void {
    const t = this.tracked.get(id)
    if (!t) return
    t.el.removeEventListener('loadedmetadata', t.onLoaded)
    t.el.removeEventListener('durationchange', t.onLoaded)
    try {
      t.el.cancelVideoFrameCallback(t.rvfcHandle)
    } catch {
      /* ignore */
    }
    this.tracked.delete(id)
    this.recomputeDuration()
  }

  private recomputeDuration(): void {
    let max = 0
    for (const t of this.tracked.values()) {
      if (isFinite(t.el.duration) && t.el.duration > max) max = t.el.duration
    }
    this.duration = max
  }

  private applySeek(t: Tracked, time: number): void {
    const target = time - t.offset
    const limit = isFinite(t.el.duration) ? t.el.duration : target
    try {
      t.el.currentTime = Math.max(0, Math.min(target, limit))
    } catch {
      /* element not ready yet */
    }
  }

  private computeMaster(): number {
    if (!this.playing) return this.masterTime
    const elapsed = ((performance.now() - this.anchorWall) / 1000) * this.rate
    return this.anchorMedia + elapsed
  }

  private reanchor(): void {
    this.anchorWall = performance.now()
    this.anchorMedia = this.masterTime
  }

  // --- transport ------------------------------------------------------------

  play(): void {
    const dur = this.sessionDuration || this.duration
    if (this.playing || dur === 0) return
    if (this.masterTime >= dur) this.masterTime = 0
    this.playing = true
    this.reanchor()
    for (const t of this.tracked.values()) {
      this.applySeek(t, this.masterTime)
      void t.el.play().catch(() => {})
    }
  }

  pause(): void {
    if (!this.playing) return
    const dur = this.sessionDuration || this.duration
    this.masterTime = Math.min(this.computeMaster(), dur)
    this.playing = false
    for (const t of this.tracked.values()) {
      t.el.pause()
      t.el.playbackRate = this.rate
    }
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /** Seek to an absolute time (seconds). */
  seek(time: number): void {
    const dur = this.sessionDuration || this.duration
    this.masterTime = Math.max(0, Math.min(time, dur || time))
    this.reanchor()
    for (const t of this.tracked.values()) this.applySeek(t, this.masterTime)
  }

  /** Relative seek (e.g. ±5s). */
  skip(delta: number): void {
    this.seek(this.masterTime + delta)
  }

  /** Step exactly one frame while paused. */
  stepFrame(dir: 1 | -1): void {
    if (this.playing) this.pause()
    this.seek(this.masterTime + dir * FRAME)
  }

  setRate(rate: number): void {
    if (this.playing) {
      // re-anchor so the new rate applies from "now" without a time jump
      this.masterTime = this.computeMaster()
      this.rate = rate
      this.reanchor()
    } else {
      this.rate = rate
    }
    for (const t of this.tracked.values()) t.el.playbackRate = rate
  }

  getDuration(): number {
    return this.sessionDuration || this.duration
  }

  isPlaying(): boolean {
    return this.playing
  }

  // --- main loop ------------------------------------------------------------

  private loop = (): void => {
    if (this.disposed) return
    const master = this.computeMaster()
    const durLimit = this.sessionDuration || this.duration

    if (this.playing && durLimit > 0 && master >= durLimit) {
      this.masterTime = durLimit
      this.playing = false
      for (const t of this.tracked.values()) t.el.pause()
    } else {
      this.masterTime = master
    }

    if (this.playing) {
      for (const t of this.tracked.values()) {
        const dur = isFinite(t.el.duration) ? t.el.duration : Infinity
        const desired = Math.min(this.masterTime - t.offset, dur)
        const drift = t.el.currentTime - desired
        const abs = Math.abs(drift)
        if (abs > HARD_DRIFT) {
          this.applySeek(t, desired + t.offset)
          t.el.playbackRate = this.rate
        } else if (abs > SOFT_DRIFT) {
          // video ahead of master -> slow down; behind -> speed up
          t.el.playbackRate = this.rate * (drift > 0 ? 1 - NUDGE : 1 + NUDGE)
        } else {
          t.el.playbackRate = this.rate
        }
      }
    }

    this.emit()
    this.raf = requestAnimationFrame(this.loop)
  }

  /** Build a snapshot on demand (used by emit() and getSnapshot()). */
  getSnapshot(): SyncSnapshot {
    return this.buildSnapshot()
  }

  private buildSnapshot(): SyncSnapshot {
    type Entry = {
      t: Tracked
      mediaTime: number
      ended: boolean
      presenting: boolean
      active: boolean
    }
    const now = performance.now()
    const entries: Entry[] = []
    const master = this.masterTime

    for (const t of this.tracked.values()) {
      const dur = isFinite(t.el.duration) ? t.el.duration : Infinity
      const ended = dur !== Infinity && master >= t.offset + dur - 0.001
      const ready = t.el.readyState >= 2
      const presenting = t.lastPresentWall > 0 && now - t.lastPresentWall < 100
      const mediaTime = t.mediaTime || t.el.currentTime
      // Only cameras that are actively presenting frames yield trustworthy
      // on-screen timing (rVFC freezes when the window is occluded/hidden).
      entries.push({
        t,
        mediaTime,
        ended,
        presenting,
        active: ready && !ended && !t.el.seeking && presenting
      })
    }

    const activeMts = entries.filter((e) => e.active).map((e) => e.mediaTime + e.t.offset)
    const mean = activeMts.length
      ? activeMts.reduce((a, b) => a + b, 0) / activeMts.length
      : 0
    const interCamSpread =
      activeMts.length >= 2 ? Math.max(...activeMts) - Math.min(...activeMts) : 0

    let maxAbsTrueDrift = 0
    const cameras: CameraDiag[] = entries.map((e) => {
      const sessionMediaTime = e.mediaTime + e.t.offset
      const trueDrift = sessionMediaTime - master
      if (e.active) maxAbsTrueDrift = Math.max(maxAbsTrueDrift, Math.abs(trueDrift))
      return {
        id: e.t.id,
        drift: (e.t.el.currentTime + e.t.offset) - master,
        trueDrift,
        groupOffset: e.active ? sessionMediaTime - mean : 0,
        mediaTime: e.t.mediaTime,
        duration: isFinite(e.t.el.duration) ? e.t.el.duration : 0,
        ready: e.t.el.readyState >= 2,
        seeking: e.t.el.seeking,
        ended: e.ended,
        presenting: e.presenting,
        measuredFps: e.t.measuredFps
      }
    })

    return {
      playing: this.playing,
      masterTime: master,
      duration: this.sessionDuration || this.duration,
      rate: this.rate,
      cameras,
      interCamSpread,
      maxAbsTrueDrift
    }
  }

  private emit(): void {
    if (this.onUpdate) this.onUpdate(this.buildSnapshot())
  }

  /** Per-camera controller-level state (for diagnostics/self-test). */
  debugDump(): string {
    const parts: string[] = []
    for (const t of this.tracked.values()) {
      const el = t.el
      parts.push(
        `${t.id}[ct=${el.currentTime.toFixed(2)} rs=${el.readyState} ns=${el.networkState} ` +
          `pause=${el.paused ? 1 : 0} seek=${el.seeking ? 1 : 0} mt=${t.mediaTime.toFixed(2)}]`
      )
    }
    return parts.join(' ')
  }

  dispose(): void {
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const id of [...this.tracked.keys()]) this.unregisterVideo(id)
  }
}
