// Fictional byte fixtures for structural tests. No real documents or pixel decoding.
import { pngCrc } from '../lib/image-header.ts'

export function pngChunk(name: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(name), data])
  const n = Buffer.alloc(4), crc = Buffer.alloc(4)
  n.writeUInt32BE(data.length); crc.writeUInt32BE(pngCrc(body))
  return Buffer.concat([n, body, crc])
}
export function smallPng(width = 120, height = 40, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', Buffer.from([0x78, 0x9c, 3, 0, 0, 0, 0, 1])), pngChunk('IEND', Buffer.alloc(0))])
}
export const jpegSegment = (marker: number, data: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([head, data])
}
export const smallJpeg = (segments: Buffer[] = []) => Buffer.concat([
  Buffer.from([0xff, 0xd8]), ...segments, jpegSegment(0xc0, Buffer.from([8, 0, 40, 0, 120])), jpegSegment(0xda, Buffer.alloc(0)), Buffer.from([1, 2, 0xff, 0, 3, 0xff, 0xd0, 4, 0xff, 0xd9]),
])
export const smallGif = () => Buffer.from('474946383961780028000000002c00000000780028000002020100003b', 'hex')
