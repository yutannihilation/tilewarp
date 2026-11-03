/**
 * Minimal PNG codec: zlib through the runtime's native `DecompressionStream`
 * / `CompressionStream`, which is several times faster than inflating and
 * deflating in JS.
 */

import { compress, decompress } from './compress.ts'

export interface RgbaImage {
  width: number
  height: number
  /** 8-bit RGBA, row-major. */
  data: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const COLOR_GRAY = 0
const COLOR_RGB = 2
const COLOR_PALETTE = 3
const COLOR_GRAY_ALPHA = 4
const COLOR_RGBA = 6

/** Samples per pixel by color type. */
const CHANNELS: Record<number, number> = {
  [COLOR_GRAY]: 1,
  [COLOR_RGB]: 3,
  [COLOR_PALETTE]: 1,
  [COLOR_GRAY_ALPHA]: 2,
  [COLOR_RGBA]: 4,
}

/**
 * Decode a non-interlaced PNG to RGBA: 8-bit gray, gray + alpha, RGB or RGBA,
 * or indexed color at any bit depth.
 *
 * @throws On other bit depths, interlacing, or a malformed file.
 */
export async function decodePngToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('Not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const idat: Uint8Array[] = []
  for (let o = 8; o + 8 <= bytes.length; ) {
    const length = view.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7])
    const data = bytes.subarray(o + 8, o + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(o + 8)
      height = view.getUint32(o + 12)
      depth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported')
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    o += 12 + length
  }

  const channels = CHANNELS[colorType]
  if (channels === undefined) throw new Error(`Unknown PNG color type ${colorType}`)
  if (colorType === COLOR_PALETTE ? depth > 8 : depth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${depth} for color type ${colorType}`)
  }
  if (colorType === COLOR_PALETTE && !palette) throw new Error('Indexed PNG without a palette')
  const stride = Math.ceil((width * channels * depth) / 8)
  const raw = await decompress(idat, 'deflate')
  if (raw.length < height * (stride + 1)) throw new Error('Truncated PNG data')
  unfilter(raw, height, stride, Math.max(1, (channels * depth) >> 3))

  // 8-bit gray / RGB with a tRNS chunk: one sample value is transparent.
  const keyGray = colorType === COLOR_GRAY && transparency ? transparency[1] : -1
  const keyRgb =
    colorType === COLOR_RGB && transparency ? (transparency[1] << 16) | (transparency[3] << 8) | transparency[5] : -1

  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1) + 1
    const d0 = y * width * 4
    switch (colorType) {
      case COLOR_RGBA:
        out.set(raw.subarray(row, row + stride), d0)
        break
      case COLOR_RGB:
        for (let x = 0, s = row, d = d0; x < width; x++, s += 3, d += 4) {
          out[d] = raw[s]
          out[d + 1] = raw[s + 1]
          out[d + 2] = raw[s + 2]
          out[d + 3] = ((raw[s] << 16) | (raw[s + 1] << 8) | raw[s + 2]) === keyRgb ? 0 : 255
        }
        break
      case COLOR_GRAY:
      case COLOR_GRAY_ALPHA:
        for (let x = 0, s = row, d = d0; x < width; x++, s += channels, d += 4) {
          out[d] = out[d + 1] = out[d + 2] = raw[s]
          out[d + 3] = channels === 2 ? raw[s + 1] : raw[s] === keyGray ? 0 : 255
        }
        break
      case COLOR_PALETTE: {
        const plte = palette as Uint8Array
        const perByte = 8 / depth
        const mask = (1 << depth) - 1
        for (let x = 0, d = d0; x < width; x++, d += 4) {
          const byte = raw[row + Math.floor(x / perByte)]
          const index = (byte >> ((perByte - 1 - (x % perByte)) * depth)) & mask
          out[d] = plte[3 * index]
          out[d + 1] = plte[3 * index + 1]
          out[d + 2] = plte[3 * index + 2]
          out[d + 3] = transparency && index < transparency.length ? transparency[index] : 255
        }
        break
      }
    }
  }
  return { width, height, data: out }
}

/**
 * Encode RGBA as an 8-bit PNG: RGB when every pixel is opaque, RGBA
 * otherwise. Rows are unfiltered, which compresses map tiles (flat colors)
 * both smallest and fastest.
 */
export async function encodeRgbaToPng(image: RgbaImage): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, data } = image
  let opaque = true
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false
      break
    }
  }
  const channels = opaque ? 3 : 4
  const stride = width * channels
  // Each row: filter byte 0 (none), then the samples.
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1) + 1
    if (opaque) {
      for (let x = 0, s = y * width * 4, d = o; x < width; x++, s += 4, d += 3) {
        raw[d] = data[s]
        raw[d + 1] = data[s + 1]
        raw[d + 2] = data[s + 2]
      }
    } else {
      raw.set(data.subarray(y * stride, (y + 1) * stride), o)
    }
  }

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = opaque ? COLOR_RGB : COLOR_RGBA
  const chunks: [string, Uint8Array][] = [
    ['IHDR', ihdr],
    ['IDAT', await compress(raw, 'deflate')],
    ['IEND', new Uint8Array(0)],
  ]

  const out = new Uint8Array(8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0))
  const view = new DataView(out.buffer)
  out.set(SIGNATURE)
  let o = 8
  for (const [type, chunk] of chunks) {
    view.setUint32(o, chunk.length)
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i)
    out.set(chunk, o + 8)
    view.setUint32(o + 8 + chunk.length, crc32(out.subarray(o + 4, o + 8 + chunk.length)))
    o += 12 + chunk.length
  }
  return out
}

/** Undo PNG row filters in place; each row is a filter byte plus `stride` bytes. */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): void {
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1) + 1
    const prev = row - stride - 1
    const filter = raw[row - 1]
    switch (filter) {
      case 0:
        break
      case 1:
        for (let i = bpp; i < stride; i++) raw[row + i] += raw[row + i - bpp]
        break
      case 2:
        if (y > 0) for (let i = 0; i < stride; i++) raw[row + i] += raw[prev + i]
        break
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? raw[row + i - bpp] : 0
          const up = y > 0 ? raw[prev + i] : 0
          raw[row + i] += (left + up) >> 1
        }
        break
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? raw[row + i - bpp] : 0
          const b = y > 0 ? raw[prev + i] : 0
          const c = i >= bpp && y > 0 ? raw[prev + i - bpp] : 0
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          raw[row + i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        break
      default:
        throw new Error(`Unknown PNG filter ${filter}`)
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
