// Keep this list in sync with the keydown handler in App.tsx — it's the only
// on-screen reference for the shortcuts (toggled by `?` or the header button).
const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Space'], label: 'Play / pause' },
  { keys: ['←', '→'], label: 'Seek ∓5s' },
  { keys: ['Shift', '←', '→'], label: 'Seek ∓1s' },
  { keys: [',', '.'], label: 'Step one frame' },
  { keys: ['[', ']'], label: 'Previous / next clip' },
  { keys: ['g'], label: 'Toggle clip gallery' },
  { keys: ['h'], label: 'Toggle HUD' },
  { keys: ['m'], label: 'Toggle map' },
  { keys: ['d'], label: 'Toggle diagnostics' },
  { keys: ['?'], label: 'Toggle this help' }
]

export default function ShortcutsOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-80 rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
          >
            ✕
          </button>
        </div>
        <dl className="flex flex-col gap-2">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-3">
              <dt className="text-xs text-slate-400">{s.label}</dt>
              <dd className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
                  >
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
