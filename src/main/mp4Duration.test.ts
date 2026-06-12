import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readMp4DurationSeconds } from './mp4Duration'

let dir: string
let fileNo = 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mp4dur-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeFixture(...parts: Buffer[]): Promise<string> {
  const p = join(dir, `f${fileNo++}.mp4`)
  await writeFile(p, Buffer.concat(parts))
  return p
}

/** A box with a 32-bit size header: size(4) + type(4) + payload. */
function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

/** A box using the 64-bit largesize form: size=1 marker + 64-bit size at offset 8. */
function largeBox(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(16)
  head.writeUInt32BE(1, 0)
  head.write(type, 4, 'latin1')
  head.writeUInt32BE(0, 8) // high word
  head.writeUInt32BE(16 + payload.length, 12)
  return Buffer.concat([head, payload])
}

function mvhdV0(timescale: number, duration: number): Buffer {
  // version/flags(4) + ctime(4) + mtime(4) + timescale(4) + duration(4) + rest(80)
  const payload = Buffer.alloc(100)
  payload.writeUInt8(0, 0)
  payload.writeUInt32BE(timescale, 12)
  payload.writeUInt32BE(duration, 16)
  return box('mvhd', payload)
}

function mvhdV1(timescale: number, duration: number): Buffer {
  // version/flags(4) + ctime(8) + mtime(8) + timescale(4) + duration(8) + rest(80)
  const payload = Buffer.alloc(112)
  payload.writeUInt8(1, 0)
  payload.writeUInt32BE(timescale, 20)
  payload.writeUInt32BE(Math.floor(duration / 2 ** 32), 24)
  payload.writeUInt32BE(duration % 2 ** 32, 28)
  return box('mvhd', payload)
}

const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'))

describe('readMp4DurationSeconds', () => {
  it('reads a version-0 mvhd duration', async () => {
    const p = await writeFixture(ftyp, box('moov', mvhdV0(1000, 63500)))
    expect(await readMp4DurationSeconds(p)).toBeCloseTo(63.5, 6)
  })

  it('reads a version-1 mvhd (64-bit duration field)', async () => {
    const p = await writeFixture(ftyp, box('moov', mvhdV1(90000, 90000 * 30)))
    expect(await readMp4DurationSeconds(p)).toBeCloseTo(30, 6)
  })

  it('skips mdat by declared size — never scans its payload for "moov"', async () => {
    // A decoy "moov" byte sequence inside mdat must not be parsed as a box.
    const decoy = Buffer.concat([
      Buffer.alloc(64, 0xaa),
      Buffer.from('moovjunkjunkjunk', 'latin1'),
      Buffer.alloc(64, 0xbb)
    ])
    const p = await writeFixture(ftyp, box('mdat', decoy), box('moov', mvhdV0(1000, 5000)))
    expect(await readMp4DurationSeconds(p)).toBeCloseTo(5, 6)
  })

  it('walks past a 64-bit largesize box header', async () => {
    const p = await writeFixture(
      ftyp,
      largeBox('free', Buffer.alloc(8)),
      box('moov', mvhdV0(600, 1200))
    )
    expect(await readMp4DurationSeconds(p)).toBeCloseTo(2, 6)
  })

  it('treats box size 0 as extending to EOF', async () => {
    const moov = box('moov', mvhdV0(1000, 7000))
    moov.writeUInt32BE(0, 0) // size 0: moov runs to end of file
    const p = await writeFixture(ftyp, moov)
    expect(await readMp4DurationSeconds(p)).toBeCloseTo(7, 6)
  })

  it('returns null when moov starts with something other than mvhd', async () => {
    const p = await writeFixture(ftyp, box('moov', box('trak', Buffer.alloc(100))))
    expect(await readMp4DurationSeconds(p)).toBeNull()
  })

  it('returns null for a zero timescale or non-positive duration', async () => {
    const zeroScale = await writeFixture(ftyp, box('moov', mvhdV0(0, 5000)))
    expect(await readMp4DurationSeconds(zeroScale)).toBeNull()
    const zeroDur = await writeFixture(ftyp, box('moov', mvhdV0(1000, 0)))
    expect(await readMp4DurationSeconds(zeroDur)).toBeNull()
  })

  it('returns null for truncated, empty, and garbage files', async () => {
    expect(await readMp4DurationSeconds(await writeFixture(Buffer.alloc(4)))).toBeNull()
    expect(await readMp4DurationSeconds(await writeFixture(Buffer.alloc(0)))).toBeNull()
    expect(await readMp4DurationSeconds(await writeFixture(Buffer.alloc(256, 0x42)))).toBeNull()
    // moov present but the mvhd read truncates mid-header
    const truncated = Buffer.concat([ftyp, box('moov', mvhdV0(1000, 5000))]).subarray(0, ftyp.length + 12)
    expect(await readMp4DurationSeconds(await writeFixture(truncated))).toBeNull()
  })

  it('returns null for a nonexistent path', async () => {
    expect(await readMp4DurationSeconds(join(dir, 'missing.mp4'))).toBeNull()
  })
})
