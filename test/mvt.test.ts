import { describe, expect, it } from 'vitest'
import { quantizeLine, quantizePolygon, quantizeRing } from '../src/mvt/clean.ts'
import { clipLine, clipPoints, clipRing, type Rect } from '../src/mvt/clip.ts'
import { decodeTile } from '../src/mvt/decode.ts'
import { encodeTile } from '../src/mvt/encode.ts'
import { type Layer, signedArea2 } from '../src/mvt/geometry.ts'
import { type DensifyOptions, transformLine, transformRing } from '../src/mvt/transform.ts'

const UNIT: Rect = { minX: 0, minY: 0, maxX: 10, maxY: 10 }

/** A ring rotated to start at its lowest (x, y) point, since the start is arbitrary. */
function canonical(ring: number[]): number[] {
  let best = 0
  for (let i = 2; i < ring.length; i += 2) {
    if (ring[i] < ring[best] || (ring[i] === ring[best] && ring[i + 1] < ring[best + 1])) best = i
  }
  return [...ring.slice(best), ...ring.slice(0, best)]
}
const DENSIFY: DensifyOptions = { tolerance: 0.5, maxDepth: 8, maxSegment: 1e6, minChord: 0 }

/** A transform that bends straight lines: y gains a quadratic in x. */
const bend = (x: number, y: number): [number, number] => [x, y + 0.01 * x * x]

describe('encodeTile / decodeTile', () => {
  it('round-trips ids, every property type, and all geometry types', () => {
    const layers: Layer[] = [
      {
        name: 'a',
        extent: 4096,
        features: [
          {
            id: 7,
            properties: { s: 'text', i: 42, n: -3, d: 1.5, t: true, f: false },
            geometry: { type: 1, points: [1, 2, 3, 4] },
          },
          {
            properties: { s: 'text' },
            geometry: {
              type: 2,
              lines: [
                [0, 0, 10, 0],
                [5, 5, 5, 9, 9, 9],
              ],
            },
          },
          {
            id: 9,
            properties: {},
            geometry: {
              type: 3,
              polygons: [{ exterior: [0, 0, 10, 0, 10, 10, 0, 10], holes: [[2, 2, 2, 8, 8, 8, 8, 2]] }],
            },
          },
        ],
      },
      { name: 'b', extent: 256, features: [{ properties: { k: 'v' }, geometry: { type: 1, points: [0, 0] } }] },
    ]
    expect(decodeTile(encodeTile(layers))).toEqual(layers)
  })

  it('leaves out layers without features and encodes nothing as 0 bytes', () => {
    expect(encodeTile([{ name: 'empty', extent: 4096, features: [] }])).toHaveLength(0)
    expect(decodeTile(new Uint8Array(0))).toEqual([])
  })
})

describe('clipLine', () => {
  it('cuts a line crossing a corner into the part inside', () => {
    // From outside the left edge, through the top-left corner region, out the top.
    expect(clipLine([-5, 5, 5, 5, 5, 15], UNIT)).toEqual([[0, 5, 5, 5, 5, 10]])
  })

  it('splits a line that leaves and re-enters', () => {
    expect(clipLine([2, 5, 15, 5, 15, 8, 2, 8], UNIT)).toEqual([
      [2, 5, 10, 5],
      [10, 8, 2, 8],
    ])
  })

  it('drops a line entirely outside', () => {
    expect(clipLine([20, 20, 30, 30], UNIT)).toEqual([])
  })
})

describe('clipRing', () => {
  it('keeps the part of a ring inside, with edges along the boundary', () => {
    const square = [5, 5, 15, 5, 15, 15, 5, 15]
    expect(canonical(clipRing(square, UNIT))).toEqual([5, 5, 10, 5, 10, 10, 5, 10])
  })

  it('clips a hole crossing an edge and keeps its orientation', () => {
    const hole = [8, 2, 8, 4, 12, 4, 12, 2] // reversed (negative) orientation
    const clipped = clipRing(hole, UNIT)
    expect(canonical(clipped)).toEqual([8, 2, 8, 4, 10, 4, 10, 2])
    expect(Math.sign(signedArea2(clipped))).toBe(Math.sign(signedArea2(hole)))
  })

  it('returns nothing for a ring outside', () => {
    expect(clipRing([20, 20, 30, 20, 30, 30], UNIT)).toEqual([])
  })
})

describe('clipPoints', () => {
  it('keeps points on the edges and drops those beyond', () => {
    expect(clipPoints([0, 0, 10, 10, 10.5, 3, -1, 3], UNIT)).toEqual([0, 0, 10, 10])
  })
})

describe('transformLine', () => {
  it('adds points where the image curves and keeps the chord error within tolerance', () => {
    const [line] = transformLine([0, 0, 100, 0], bend, DENSIFY)
    expect(line.length).toBeGreaterThan(4)
    for (let i = 2; i < line.length; i += 2) {
      // The midpoint of each output segment, mapped back to source x, must be
      // within tolerance of the curve.
      const mx = (line[i - 2] + line[i]) / 2
      const my = (line[i - 1] + line[i + 1]) / 2
      expect(Math.abs(my - bend(mx, 0)[1])).toBeLessThanOrEqual(DENSIFY.tolerance)
    }
  })

  it('splits where a point has no image', () => {
    const f = (x: number, y: number): [number, number] => (x === 5 ? [Number.NaN, Number.NaN] : [x, y])
    expect(transformLine([0, 0, 5, 0, 10, 0, 15, 0], f, DENSIFY)).toEqual([[10, 0, 15, 0]])
  })

  it('splits at a seam: a jump that survives the recursion limit', () => {
    // Everything right of x = 5 is a world away.
    const f = (x: number, y: number): [number, number] => [x > 5 ? x + 1e6 : x, y]
    const parts = transformLine([0, 0, 10, 0], f, { ...DENSIFY, maxSegment: 1000 })
    expect(parts).toHaveLength(2)
    expect(parts[0][0]).toBe(0)
    expect(parts[1].at(-2)).toBe(10 + 1e6)
  })
})

describe('transformRing', () => {
  it('densifies the closing segment too', () => {
    const ring = transformRing([0, 0, 100, 0, 100, 1], bend, DENSIFY)
    expect(ring).not.toBeNull()
    expect(ring?.length).toBeGreaterThan(6)
  })

  it('is dropped when a vertex has no image', () => {
    const f = (x: number, y: number): [number, number] => (x === 100 ? [Number.NaN, Number.NaN] : [x, y])
    expect(transformRing([0, 0, 100, 0, 100, 1], f, DENSIFY)).toBeNull()
  })
})

describe('quantize', () => {
  it('rounds lines and drops repeated points; a collapsed line is dropped', () => {
    expect(quantizeLine([0.4, 0.4, 0.6, 0.4, 1.4, 0.6, 1.4, 0.6])).toEqual([0, 0, 1, 0, 1, 1])
    expect(quantizeLine([0.2, 0.2, 0.4, 0.4])).toBeNull()
  })

  it('drops a ring that collapses to zero area', () => {
    expect(quantizeRing([0, 0, 10, 0, 20, 0], true)).toBeNull()
    expect(quantizeRing([0, 0, 0.2, 0.1, 0.1, 0.3], true)).toBeNull()
  })

  it('gives rings the winding of their role, whatever came in', () => {
    const cw = [0, 0, 10, 0, 10, 10, 0, 10] // positive by the MVT formula
    expect(signedArea2(cw)).toBeGreaterThan(0)
    const ccw = [0, 0, 0, 10, 10, 10, 10, 0]
    expect(quantizeRing(ccw, true)).toEqual([10, 0, 10, 10, 0, 10, 0, 0])
    expect(quantizeRing(cw, false)).toEqual([0, 10, 10, 10, 10, 0, 0, 0])
    expect(quantizeRing(cw, true)).toEqual(cw)
  })

  it('keeps roles through a reflecting transform and a clip', () => {
    // Swapping the axes reflects: both rings come out with the wrong sign.
    const swap = (x: number, y: number): [number, number] => [y, x]
    const exterior = transformRing([0, 0, 10, 0, 10, 10, 0, 10], swap, DENSIFY)
    const hole = transformRing([2, 2, 2, 8, 8, 8, 8, 2], swap, DENSIFY)
    expect(signedArea2(exterior!)).toBeLessThan(0)
    expect(signedArea2(hole!)).toBeGreaterThan(0)
    const rect: Rect = { minX: 0, minY: 0, maxX: 5, maxY: 10 }
    const polygon = quantizePolygon({ exterior: clipRing(exterior!, rect), holes: [clipRing(hole!, rect)] })
    expect(polygon).not.toBeNull()
    expect(signedArea2(polygon!.exterior)).toBeGreaterThan(0)
    expect(polygon!.holes).toHaveLength(1)
    expect(signedArea2(polygon!.holes[0])).toBeLessThan(0)
  })

  it('drops the holes of a polygon whose exterior is gone', () => {
    expect(quantizePolygon({ exterior: [0, 0, 1, 0, 2, 0], holes: [[0, 0, 10, 0, 10, 10]] })).toBeNull()
  })
})
