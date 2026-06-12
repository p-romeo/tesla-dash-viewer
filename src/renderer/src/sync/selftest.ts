import type { SyncEngine } from './SyncEngine'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Headless sync self-test (enabled with TESLA_SELFTEST=1). Auto-plays the loaded
 * clip, samples the gate metrics for ~8s, performs a mid-clip seek, then samples
 * re-convergence. All output goes to console.* which the main process forwards to
 * stdout in dev — so `TESLA_SELFTEST=1 timeout 30 npm run preview` prints real
 * measured drift without anyone watching the window.
 *
 * Caveat: if the window is backgrounded, Chromium throttles requestAnimationFrame
 * and the correction loop slows, inflating the numbers. Interpret with a visible,
 * foreground window.
 */
export async function runSelfTest(engine: SyncEngine): Promise<void> {
  // Wait until metadata is known and at least 2 cameras are decode-ready.
  for (let i = 0; i < 50; i++) {
    const s = engine.getSnapshot()
    if (s.duration > 0 && s.cameras.filter((c) => c.ready).length >= 2) break
    await sleep(100)
  }

  // Only samples where every camera is composited (all ready) are trustworthy:
  // requestVideoFrameCallback freezes for an occluded/hidden window, which would
  // otherwise pollute the spread with stale frames. We score `valid` samples only.
  type Sample = { spread: number; valid: boolean }
  const sample = (label: string): Sample => {
    const s = engine.getSnapshot()
    const spread = Math.round(s.interCamSpread * 1000)
    const trueDrift = Math.round(s.maxAbsTrueDrift * 1000)
    const presenting = s.cameras.filter((c) => c.presenting).length
    const valid = s.cameras.length > 0 && presenting === s.cameras.length
    console.log(
      `[selftest] ${label.padEnd(16)} t=${s.masterTime.toFixed(2)}s ` +
        `spread=${spread}ms maxTrueDrift=${trueDrift}ms ` +
        `playing=${s.playing} presenting=${presenting}/${s.cameras.length}${valid ? '' : ' (occluded?)'}`
    )
    return { spread, valid }
  }

  console.log('[selftest] BEGIN — multi-camera sync measurement')
  console.log('[selftest] NOTE: only "all cameras composited" samples are scored;')
  console.log('[selftest]       rVFC freezes for an occluded/hidden window.')
  engine.seek(0)
  engine.play()

  const samples: Sample[] = []
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    samples.push(sample(`play +${((i + 1) * 0.5).toFixed(1)}s`))
    if (i < 6) console.log(`[selftest]   ctrl: ${engine.debugDump()}`)
  }

  console.log('[selftest] --- seek to 30s (mid-clip) ---')
  engine.seek(30)
  for (let i = 0; i < 6; i++) {
    await sleep(400)
    samples.push(sample(`postseek +${((i + 1) * 0.4).toFixed(1)}s`))
  }

  engine.pause()
  sample('paused')

  const valid = samples.filter((s) => s.valid).map((s) => s.spread)
  if (valid.length === 0) {
    console.log(
      '[selftest] RESULT: no fully-composited samples (window was hidden/occluded). ' +
        'Run with the window visible & focused to measure on-screen sync.'
    )
  } else {
    const worst = Math.max(...valid)
    const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
    console.log(
      `[selftest] RESULT over ${valid.length}/${samples.length} composited samples: ` +
        `avg=${avg}ms worst=${worst}ms (gate: < 2 frames ≈ 56ms) -> ${worst <= 56 ? 'PASS' : 'CHECK'}`
    )
  }
  console.log('[selftest] END')
}
