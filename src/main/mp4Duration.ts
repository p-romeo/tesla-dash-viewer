import { promises as fs } from 'fs'

// Tesla MP4s report a bogus container frame rate (10000/1) but the moov/mvhd
// duration is reliable (NOTES.md §4). We read it without decoding by walking the
// top-level box list to moov, then parsing its first child (mvhd). We never read
// mdat — we skip it by its declared size, which also avoids matching a stray
// "moov" byte sequence inside the media payload.

const HEADER_BYTES = 16 // size(4) + type(4), plus room for a 64-bit largesize
const MVHD_BYTES = 120 // a full version-1 mvhd box: header (8) + payload (112)

/** Read an MP4's duration in seconds from its moov/mvhd box, or null on failure. */
export async function readMp4DurationSeconds(path: string): Promise<number | null> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(path, 'r')
    const { size: fileSize } = await handle.stat()

    let offset = 0
    while (offset + 8 <= fileSize) {
      const head = Buffer.alloc(HEADER_BYTES)
      const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, offset)
      if (bytesRead < 8) return null

      let boxSize = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let headerLen = 8
      if (boxSize === 1) {
        if (bytesRead < 16) return null
        // 64-bit largesize; durations here are small so the high word is 0.
        boxSize = head.readUInt32BE(8) * 2 ** 32 + head.readUInt32BE(12)
        headerLen = 16
      } else if (boxSize === 0) {
        boxSize = fileSize - offset // extends to EOF
      }
      if (boxSize < headerLen) return null

      if (type === 'moov') {
        return await parseMoovDuration(handle, offset + headerLen)
      }
      offset += boxSize
    }
    return null
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

/** Parse mvhd (moov's first child) starting at `childOffset`. */
async function parseMoovDuration(
  handle: fs.FileHandle,
  childOffset: number
): Promise<number | null> {
  const buf = Buffer.alloc(MVHD_BYTES)
  const { bytesRead } = await handle.read(buf, 0, MVHD_BYTES, childOffset)
  if (bytesRead < 16) return null
  if (buf.toString('latin1', 4, 8) !== 'mvhd') return null

  const version = buf.readUInt8(8) // first byte of the mvhd payload
  let timescale: number
  let duration: number
  if (version === 1) {
    // version/flags(4) + ctime(8) + mtime(8) -> timescale(4) + duration(8)
    if (bytesRead < 40) return null
    timescale = buf.readUInt32BE(28)
    duration = buf.readUInt32BE(32) * 2 ** 32 + buf.readUInt32BE(36)
  } else {
    // version/flags(4) + ctime(4) + mtime(4) -> timescale(4) + duration(4)
    if (bytesRead < 28) return null
    timescale = buf.readUInt32BE(20)
    duration = buf.readUInt32BE(24)
  }
  if (!timescale || duration <= 0) return null
  return duration / timescale
}
