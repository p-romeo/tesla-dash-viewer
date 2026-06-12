import { describe, expect, it } from 'vitest'
import { parseRange } from './httpRange'

const SIZE = 1000

describe('parseRange', () => {
  it('parses a bounded range', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 })
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ kind: 'range', start: 500, end: 999 })
  })

  it('parses an open-ended range to EOF', () => {
    expect(parseRange('bytes=100-', SIZE)).toEqual({ kind: 'range', start: 100, end: 999 })
    expect(parseRange('bytes=0-', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 })
  })

  it('clamps an end past EOF', () => {
    expect(parseRange('bytes=0-9999', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 })
  })

  it('treats bytes=-n as the LAST n bytes (suffix form)', () => {
    // The pre-extraction handler parsed this as 0..n — the first n+1 bytes.
    expect(parseRange('bytes=-500', SIZE)).toEqual({ kind: 'range', start: 500, end: 999 })
    expect(parseRange('bytes=-1', SIZE)).toEqual({ kind: 'range', start: 999, end: 999 })
  })

  it('serves the whole file for a suffix longer than the resource', () => {
    expect(parseRange('bytes=-2000', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 })
  })

  it('rejects a zero-length suffix as unsatisfiable', () => {
    expect(parseRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('rejects a start at or past EOF as unsatisfiable', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=1500-1600', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('is unsatisfiable against an empty resource', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('ignores an inverted range per RFC 7233', () => {
    expect(parseRange('bytes=500-100', SIZE)).toEqual({ kind: 'ignore' })
  })

  it('ignores malformed headers', () => {
    expect(parseRange('bytes=-', SIZE)).toEqual({ kind: 'ignore' })
    expect(parseRange('bytes=', SIZE)).toEqual({ kind: 'ignore' })
    expect(parseRange('chunks=0-99', SIZE)).toEqual({ kind: 'ignore' })
    expect(parseRange('garbage', SIZE)).toEqual({ kind: 'ignore' })
  })

  it('honors only the first range of a multi-range request', () => {
    expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 })
  })
})
