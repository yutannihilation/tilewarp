/**
 * A {@link RasterDecoder} for browsers and their workers: 8-bit, non-interlaced
 * PNG in JS, exactly as on a server; other PNGs (16-bit, interlaced), JPEG and
 * WebP by the browser's own decoder. Drawing to a
 * canvas premultiplies alpha, so a semi-transparent WebP pixel may come back
 * a unit off in its color; opaque pixels are exact.
 */

import { SourceError } from './errors.ts'
import type { RgbaImage } from './png.ts'
import { decodePngToRgba } from './png.ts'
import type { RasterDecoder } from './source.ts'

/** The image type of encoded bytes, by their signature. */
function imageType(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  const text = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4))
  if (text(0) === 'RIFF' && text(8) === 'WEBP') return 'webp'
  return undefined
}

/**
 * Whether {@link decodePngToRgba} reads this PNG, by its IHDR chunk (the
 * first one, at a fixed offset): 8 bits per sample, or up to 8 for indexed
 * color, and no interlacing.
 */
function decodableInJs(png: Uint8Array): boolean {
  const depth = png[24]
  const colorType = png[25]
  const interlace = png[28]
  return interlace === 0 && (colorType === 3 ? depth <= 8 : depth === 8)
}

/** @throws {SourceError} If the bytes are not an image this decodes. */
export const browserDecoder: RasterDecoder = async (bytes) => {
  const type = imageType(bytes)
  if (type === undefined) throw new SourceError('A raster tile is not PNG, JPEG or WebP')
  try {
    return type === 'png' && decodableInJs(bytes) ? await decodePngToRgba(bytes) : await decodeInBrowser(bytes, type)
  } catch (error) {
    throw new SourceError(`A ${type.toUpperCase()} tile does not decode`, { cause: error })
  }
}

async function decodeInBrowser(bytes: Uint8Array, type: 'png' | 'jpeg' | 'webp'): Promise<RgbaImage> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: `image/${type}` })
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  const { width, height } = bitmap
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('No 2D canvas context to decode a raster tile with')
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const { data } = context.getImageData(0, 0, width, height)
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}
