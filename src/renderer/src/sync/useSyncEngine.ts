import { useEffect, useState } from 'react'
import { SyncEngine, type SyncSnapshot } from './SyncEngine'

const EMPTY: SyncSnapshot = {
  playing: false,
  masterTime: 0,
  duration: 0,
  rate: 1,
  cameras: [],
  interCamSpread: 0,
  maxAbsTrueDrift: 0
}

/** UI refresh rate for diagnostics/scrubber (Hz). The engine itself runs at rAF. */
const UI_HZ = 20

export function useSyncEngine(): { engine: SyncEngine; snapshot: SyncSnapshot } {
  // Lazy state init, not a ref: constructing is side-effect free (the rAF loop
  // only starts in the effect below), and a StrictMode-discarded instance is
  // never started, so it leaks nothing.
  const [engine] = useState(() => new SyncEngine())

  const [snapshot, setSnapshot] = useState<SyncSnapshot>(EMPTY)

  useEffect(() => {
    engine.start() // re-activate (StrictMode remounts this effect after disposing)
    let last = 0
    const minGap = 1000 / UI_HZ
    engine.setOnUpdate((s) => {
      const now = performance.now()
      if (now - last >= minGap) {
        last = now
        setSnapshot(s)
      }
    })
    return () => engine.dispose()
  }, [engine])

  return { engine, snapshot }
}
