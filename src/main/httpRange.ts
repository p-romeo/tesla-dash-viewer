// Range-header parsing for the media:// protocol handler (index.ts). Kept pure
// (no fs, no Response) so the seek-critical logic is unit-testable: without a
// correct 206, <video>.seekable stays empty and scrubbing breaks app-wide.

export type RangeResult =
  /** Serve bytes start..end inclusive as a 206. */
  | { kind: 'range'; start: number; end: number }
  /** No satisfiable bytes — answer 416 Range Not Satisfiable. */
  | { kind: 'unsatisfiable' }
  /** Malformed/unsupported header — per RFC 7233 ignore it and serve a full 200. */
  | { kind: 'ignore' }

/**
 * Parse an HTTP Range header against a resource of `size` bytes. Handles the
 * three single-range forms (`bytes=a-b`, `bytes=a-`, `bytes=-n` — the suffix
 * form means the LAST n bytes, not 0..n). Multi-range requests are not produced
 * by Chromium's media stack; only the first range is honored.
 */
export function parseRange(header: string, size: number): RangeResult {
  const m = /^\s*bytes=(\d*)-(\d*)/.exec(header)
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'ignore' }

  if (m[1] === '') {
    // Suffix form bytes=-n: the final n bytes of the resource.
    const n = parseInt(m[2], 10)
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 }
  }

  const start = parseInt(m[1], 10)
  let end = m[2] === '' ? size - 1 : parseInt(m[2], 10)
  if (end >= size) end = size - 1
  // RFC 7233: last-byte-pos < first-byte-pos makes the spec invalid -> ignore.
  if (m[2] !== '' && parseInt(m[2], 10) < start) return { kind: 'ignore' }
  if (start >= size) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end }
}
