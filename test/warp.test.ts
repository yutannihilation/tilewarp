import { apply } from '@developmentseed/affine'
import { decode, encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import { buildCrs, type EpsgProjJson } from '../src/crs.ts'
import { HALF_WORLD, MERCATOR_TMS } from '../src/mercator.ts'
import { decodePngToRgba, encodeRgbaToPng, type RgbaImage } from '../src/png.ts'
import { tileAffine, tmsFromAreaOfUse } from '../src/tms.ts'
import { chooseSourceZoom, mercatorField, sampleField, tileKey } from '../src/warp.ts'
import epsg3413 from './fixtures/epsg-3413.json' with { type: 'json' }
import epsg6677 from './fixtures/epsg-6677.json' with { type: 'json' }
import epsg8857 from './fixtures/epsg-8857.json' with { type: 'json' }

const identity = (x: number, y: number): [number, number] => [x, y]
const SOURCE = { minzoom: 0, maxzoom: 18, tileSize: 256 }

/** A tile whose every pixel encodes its own position. */
function patternTile(size: number, seed: number): RgbaImage {
  const data = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const o = (j * size + i) * 4
      data.set([i, j, seed, 255], o)
    }
  }
  return { width: size, height: size, data }
}

describe('tileAffine', () => {
  it('maps tile corners of the Web Mercator TMS to Web Mercator meters', () => {
    const affine = tileAffine(MERCATOR_TMS, 1, 1, 0, 256)
    expect(apply(affine, 0, 0)).toEqual([0, HALF_WORLD])
    expect(apply(affine, 256, 256)).toEqual([HALF_WORLD, 0])
  })
})

describe('tmsFromAreaOfUse', () => {
  it('returns the square centered on the projected bounds', () => {
    const tms = tmsFromAreaOfUse([0, 0, 20, 10], identity)
    expect(tms.extentAtZoom0).toBeCloseTo(20)
    expect(tms.origin[0]).toBeCloseTo(0)
    expect(tms.origin[1]).toBeCloseTo(15)
  })

  it('throws when the bounds do not project', () => {
    expect(() => tmsFromAreaOfUse([0, 0, 1, 1], () => [Number.NaN, 0])).toThrow()
  })
})

describe('warp with Web Mercator as the target', () => {
  const z = 3
  const x = 6
  const y = 3
  const affine = tileAffine(MERCATOR_TMS, z, x, y, 256)
  const field = mercatorField(affine, 256, identity, identity)

  it('puts each pixel center at its exact Web Mercator position', () => {
    const [mx, my] = apply(affine, 10.5, 20.5)
    const k = 20 * 256 + 10
    expect(field[2 * k]).toBeCloseTo(mx, 3)
    expect(field[2 * k + 1]).toBeCloseTo(my, 3)
  })

  it('chooses the same zoom and the one tile', () => {
    const choice = chooseSourceZoom(field, 256, SOURCE, 32)
    expect(choice?.z).toBe(z)
    // Bilinear neighbors at the tile edge reach into the adjacent tiles.
    expect(choice?.keys.has(tileKey(z, x, y))).toBe(true)
  })

  const out = sampleField(field, 256, z, 256, new Map([[tileKey(z, x, y), patternTile(256, 7)]]))

  it('reproduces the source tile', () => {
    // Interior pixel (edges blend with the missing neighbors' transparency).
    const o = (100 * 256 + 50) * 4
    expect([...out.data.slice(o, o + 4)]).toEqual([50, 100, 7, 255])
  })

  it('keeps colors when blending with a missing neighbor tile', () => {
    const o = (100 * 256 + 255) * 4
    expect(out.data[o + 2]).toBe(7)
  })
})

describe('buildCrs', () => {
  it('derives a TMS covering the area of use of EPSG:6677', () => {
    const crs = buildCrs(6677, epsg6677 as EpsgProjJson)
    const [x0, y0] = crs.tms.origin
    // Tokyo station is inside zone IX's area of use, so inside tile 0/0/0.
    const [mx, my] = [15558914.4, 4257452.6]
    const [cx, cy] = crs.from3857(mx, my)
    expect(cx).toBeGreaterThan(x0)
    expect(cx).toBeLessThan(x0 + crs.tms.extentAtZoom0)
    expect(cy).toBeLessThan(y0)
    expect(cy).toBeGreaterThan(y0 - crs.tms.extentAtZoom0)
    const [bx, by] = crs.to3857(cx, cy)
    expect(bx).toBeCloseTo(mx, 3)
    expect(by).toBeCloseTo(my, 3)
  })

  it('meshes a regular tile to within a fraction of an output pixel', () => {
    const crs = buildCrs(6677, epsg6677 as EpsgProjJson)
    const affine = tileAffine(crs.tms, 3, 4, 4, 256)
    const field = mercatorField(affine, 256, crs.to3857, crs.from3857)
    let maxError = 0
    for (let k = 0; k < 256 * 256; k++) {
      const [cx, cy] = apply(affine, (k % 256) + 0.5, Math.floor(k / 256) + 0.5)
      const [ex, ey] = crs.from3857(field[2 * k], field[2 * k + 1])
      maxError = Math.max(maxError, Math.hypot(ex - cx, ey - cy))
    }
    const pixel = affine[0]
    expect(maxError / pixel).toBeLessThan(0.25)
  })

  it('leaves pixels past the edge of a world projection transparent', () => {
    const crs = buildCrs(8857, epsg8857 as EpsgProjJson)
    const field = mercatorField(tileAffine(crs.tms, 0, 0, 0, 256), 256, crs.to3857, crs.from3857)
    const at = (i: number, j: number) => field[2 * (j * 256 + i)]
    // Equal Earth's outline is rounded: the left edge at mid-height is the
    // world's edge, so a pixel just inside it is valid and the corner beyond
    // the curved side is not.
    expect(Number.isNaN(at(2, 128))).toBe(false)
    expect(Number.isNaN(at(2, 80))).toBe(true)
  })

  it('handles a polar tile containing the pole and the antimeridian', () => {
    const crs = buildCrs(3413, epsg3413 as EpsgProjJson)
    const field = mercatorField(tileAffine(crs.tms, 0, 0, 0, 256), 256, crs.to3857, crs.from3857)
    // The pole is at the center of the TMS and is past Web Mercator's limit.
    const center = 128 * 256 + 128
    expect(Number.isNaN(field[2 * center])).toBe(true)
    // A pixel at lat ~60° has a position.
    const valid = [...field].filter((v) => !Number.isNaN(v)).length
    expect(valid).toBeGreaterThan(0)
    const choice = chooseSourceZoom(field, 256, SOURCE, 32)
    expect(choice).not.toBeNull()
  })
})

/** `png` with a chunk inserted before the first `before` chunk. */
function withChunk(png: Uint8Array, before: string, type: string, data: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset)
  let o = 8
  while (String.fromCharCode(...png.subarray(o + 4, o + 8)) !== before) o += 12 + view.getUint32(o)
  const chunk = new Uint8Array(12 + data.length)
  const cv = new DataView(chunk.buffer)
  cv.setUint32(0, data.length)
  chunk.set(
    [...type].map((ch) => ch.charCodeAt(0)),
    4,
  )
  chunk.set(data, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, 8 + data.length)) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  cv.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0)
  const out = new Uint8Array(png.length + chunk.length)
  out.set(png.subarray(0, o))
  out.set(chunk, o)
  out.set(png.subarray(o), o + chunk.length)
  return out
}

describe('png', () => {
  it('expands RGB to opaque RGBA', async () => {
    const rgb = encode({ width: 2, height: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6]), depth: 8, channels: 3 })
    expect([...(await decodePngToRgba(rgb)).data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
  })

  it('expands indexed color with transparency', async () => {
    const indexed = encode({
      width: 3,
      height: 1,
      data: new Uint8Array([0, 1, 2]),
      depth: 8,
      channels: 1,
      palette: [
        [10, 20, 30],
        [40, 50, 60],
        [70, 80, 90],
      ],
    })
    // fast-png writes no tRNS for indexed images; insert one before IDAT.
    const png = withChunk(indexed, 'IDAT', 'tRNS', new Uint8Array([255, 0]))
    expect([...(await decodePngToRgba(png)).data]).toEqual([10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 255])
  })

  it('undoes every row filter (fast-png picks them adaptively)', async () => {
    // A gradient with noise makes the encoder use Sub/Up/Average/Paeth rows.
    const image = patternTile(64, 3)
    for (let i = 0; i < image.data.length; i += 4) image.data[i + 2] = (i * 7919) & 0xff
    const png = encode({ ...image, depth: 8, channels: 4 })
    expect(await decodePngToRgba(png)).toEqual(image)
  })

  it('round-trips RGBA, and fast-png reads what it writes', async () => {
    const tile = patternTile(16, 3)
    tile.data[3] = 128
    const png = await encodeRgbaToPng(tile)
    expect(await decodePngToRgba(png)).toEqual(tile)
    const other = decode(png)
    expect(other.channels).toBe(4)
    expect([...other.data]).toEqual([...tile.data])
  })

  it('writes RGB for an opaque tile', async () => {
    const png = await encodeRgbaToPng(patternTile(16, 3))
    const other = decode(png)
    expect(other.channels).toBe(3)
    expect(await decodePngToRgba(png)).toEqual(patternTile(16, 3))
  })
})
