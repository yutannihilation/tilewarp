import { readFileSync } from 'node:fs'
import { parseWkt } from '@developmentseed/proj'
import type { RangeResponse, Source } from 'pmtiles'
import { PMTiles } from 'pmtiles'
import proj4 from 'proj4'
import { describe, expect, it, vi } from 'vitest'
import { buildCrs, type Crs, type EpsgProjJson } from '../src/crs.ts'
import { HALF_WORLD, WORLD } from '../src/mercator.ts'
import { decodeTile } from '../src/mvt/decode.ts'
import { encodeTile } from '../src/mvt/encode.ts'
import { type Feature, type Layer, signedArea2 } from '../src/mvt/geometry.ts'
import type { PointTransform } from '../src/mvt/transform.ts'
import {
  FIELD_SIZE,
  gridImages,
  OUTPUT_EXTENT,
  prepareSourceTile,
  renderVectorTile,
  type SourceTile,
  sourceCoverage,
  sourceTransform,
  straightChord,
  vectorMaxZoom,
} from '../src/vector.ts'
import { type MercatorField, tileKey } from '../src/warp.ts'
import { XyzSource } from '../src/xyz.ts'
import epsg3413 from './fixtures/epsg-3413.json' with { type: 'json' }
import epsg6677 from './fixtures/epsg-6677.json' with { type: 'json' }

// test/fixtures/vector.pmtiles: tippecanoe output (zoom 0-6, layer `test`)
// for a square with a hole near Tokyo (id 1), a Sapporo-Wellington line (2),
// a line across the antimeridian (3), a band at 80-85°N (4) and the points
// Tokyo (10), Mt. Fuji (11), Wellington (12) and Nuuk (13).
const FIXTURE = new Uint8Array(readFileSync(new URL('./fixtures/vector.pmtiles', import.meta.url)))
const PROJJSON: Record<number, EpsgProjJson> = {
  6677: epsg6677 as EpsgProjJson,
  3413: epsg3413 as EpsgProjJson,
}

/** `[lng, lat]` → output tile units of `z/x/y` in the CRS's tile matrix set. */
function expectedTileUnits(crs: Crs, z: number, x: number, y: number, lng: number, lat: number): [number, number] {
  // @ts-expect-error - incomplete proj4 typings
  const [X, Y] = proj4('EPSG:4326', parseWkt(crs.projjson)).forward<[number, number]>([lng, lat])
  const tileExtent = crs.tms.extentAtZoom0 / 2 ** z
  return [
    ((X - crs.tms.origin[0]) / tileExtent - x) * OUTPUT_EXTENT,
    ((crs.tms.origin[1] - Y) / tileExtent - y) * OUTPUT_EXTENT,
  ]
}

/** The fixture as an in-memory archive source. */
const fixtureSource: Source = {
  getKey: () => 'vector.pmtiles',
  getBytes: async (offset: number, length: number): Promise<RangeResponse> => ({
    data: FIXTURE.slice(offset, offset + length).buffer,
    etag: 'v1',
  }),
}

// The fixture served as an XYZ source over a stubbed fetch, as the package reads sources.
const fixture = new PMTiles(fixtureSource)
vi.stubGlobal('fetch', async (url: string) => {
  const match = /^https:\/\/fixture\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url)
  const tile = match && (await fixture.getZxy(Number(match[1]), Number(match[2]), Number(match[3])))
  return tile ? new Response(tile.data) : new Response(null, { status: 404 })
})
const source = new XyzSource({ tiles: ['https://fixture/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 6 })
const loader = async (z: number, x: number, y: number): Promise<SourceTile | null> => {
  const bytes = await source.tile(z, x, y)
  return bytes === null ? null : prepareSourceTile(bytes)
}
const SOURCE = { minzoom: 0, maxzoom: 6 }

function feature(layers: Layer[], id: number): Feature {
  const f = layers.flatMap((l) => l.features).find((f) => f.id === id)
  if (f === undefined) throw new Error(`no feature ${id}`)
  return f
}

/** [lng, lat] of the top-left corner of Web Mercator tile z/x/y. */
function tileCorner(z: number, x: number, y: number): [number, number] {
  const n = 2 ** z
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  return [(x / n) * 360 - 180, lat]
}

describe('sourceTransform', () => {
  it('matches proj4 lng/lat → CRS → tile units at source tile corners', () => {
    for (const [epsg, sz, sx, sy] of [
      [6677, 10, 908, 403],
      [3413, 8, 91, 68],
    ] as const) {
      const crs = buildCrs(epsg, PROJJSON[epsg])
      const f = sourceTransform(crs, 3, 4, 3, sz, sx, sy, 4096)
      const [u, v] = f(0, 0)
      const [eu, ev] = expectedTileUnits(crs, 3, 4, 3, ...tileCorner(sz, sx, sy))
      expect(u).toBeCloseTo(eu, 3)
      expect(v).toBeCloseTo(ev, 3)
    }
  })

  it('answers NaN where the CRS has no position', () => {
    const crs = buildCrs(6677, PROJJSON[6677])
    // 90° east of the CRS's central meridian, where the transverse Mercator
    // forward does not come back.
    const f = sourceTransform(crs, 1, 1, 0, 1, 1, 0, 4096)
    const px = (((49.8 + 180) / 360) * 2 - 1) * 4096
    expect(f(px, 4096)).toEqual([Number.NaN, Number.NaN])
  })
})

describe('prepareSourceTile', () => {
  it('keeps a point in [0, extent) only, so it belongs to one source tile', () => {
    const bytes = encodeTile([
      {
        name: 'p',
        extent: 4096,
        features: [
          { id: 1, properties: {}, geometry: { type: 1, points: [0, 0] } },
          { id: 2, properties: {}, geometry: { type: 1, points: [4095, 4095] } },
          { id: 3, properties: {}, geometry: { type: 1, points: [4096, 100] } },
          { id: 4, properties: {}, geometry: { type: 1, points: [-1, 100] } },
        ],
      },
    ])
    const ids = prepareSourceTile(bytes).layers[0].features.map((f) => f.feature.id)
    expect(ids).toEqual([1, 2])
  })

  it('clips lines and rings to the unbuffered extent', () => {
    const bytes = encodeTile([
      {
        name: 'l',
        extent: 4096,
        features: [
          { id: 1, properties: {}, geometry: { type: 2, lines: [[-100, 10, 100, 10]] } },
          {
            id: 2,
            properties: {},
            geometry: { type: 3, polygons: [{ exterior: [-64, -64, 4160, -64, 4160, 4160, -64, 4160], holes: [] }] },
          },
        ],
      },
    ])
    const [line, polygon] = prepareSourceTile(bytes).layers[0].features
    expect(line.feature.geometry).toEqual({ type: 2, lines: [[0, 10, 100, 10]] })
    expect(line.bbox).toEqual([0, 10, 100, 10])
    if (polygon.feature.geometry.type !== 3) throw new Error('expected a polygon')
    const [{ exterior, holes }] = polygon.feature.geometry.polygons
    expect(holes).toEqual([])
    expect(new Set(exterior)).toEqual(new Set([0, 4096]))
    expect(exterior).toHaveLength(8)
    expect(polygon.bbox).toEqual([0, 0, 4096, 4096])
  })
})

describe('renderVectorTile', () => {
  it('places points where proj4 does and keeps ids and properties', async () => {
    const crs = buildCrs(6677, PROJJSON[6677])
    const layers = decodeTile(await renderVectorTile(crs, SOURCE, 1, 1, 0, loader))
    const tokyo = feature(layers, 10)
    expect(tokyo.properties).toEqual({ name: 'Tokyo', rank: 0, neg: 0 })
    const [u, v] = expectedTileUnits(crs, 1, 1, 0, 139.7671, 35.6812)
    expect(tokyo.geometry).toEqual({ type: 1, points: [expect.closeTo(u, -1), expect.closeTo(v, -1)] })
  })

  it('writes exterior rings positive and holes negative', async () => {
    // The square with a hole near Tokyo in EPSG:6677; the polar band in EPSG:3413.
    for (const [epsg, id, withHole] of [
      [6677, 1, true],
      [3413, 4, false],
    ] as const) {
      const crs = buildCrs(epsg, PROJJSON[epsg])
      const layers = decodeTile(await renderVectorTile(crs, SOURCE, 0, 0, 0, loader))
      const polygons = layers
        .flatMap((l) => l.features)
        .filter((f) => f.id === id)
        .flatMap((f) => (f.geometry.type === 3 ? f.geometry.polygons : []))
      expect(polygons.length).toBeGreaterThan(0)
      for (const polygon of polygons) {
        expect(signedArea2(polygon.exterior)).toBeGreaterThan(0)
        for (const hole of polygon.holes) expect(signedArea2(hole)).toBeLessThan(0)
      }
      expect(polygons.some((p) => p.holes.length > 0)).toBe(withHole)
    }
  })

  it('returns an empty tile where nothing of the source falls', async () => {
    const crs = buildCrs(6677, PROJJSON[6677])
    expect(await renderVectorTile(crs, SOURCE, 4, 0, 15, loader)).toHaveLength(0)
  })

  it('draws a tile containing the pole without features from the far side', async () => {
    const crs = buildCrs(3413, PROJJSON[3413])
    const layers = decodeTile(await renderVectorTile(crs, SOURCE, 2, 1, 1, loader))
    const ids = layers.flatMap((l) => l.features.map((f) => f.id))
    expect(ids).toContain(4) // the polar band
    expect(ids).not.toContain(12) // Wellington
  })
})

describe('gridImages and straightChord', () => {
  it('finds no limit for an affine transform', () => {
    const affine: PointTransform = (x, y) => [2 * x + 1, 3 * y - 5]
    const grid = gridImages(affine, 4096)
    expect(grid).not.toBeNull()
    expect(straightChord(grid!, 0.5)).toBe(Number.POSITIVE_INFINITY)
  })

  it('limits segments of a transform that curves more than the tolerance allows', () => {
    // Between grid samples 512 apart, the chord error is 1e-6 * 512^2 ≈ 0.26 units.
    const bend: PointTransform = (x, y) => [x, y + 1e-6 * x * x]
    const grid = gridImages(bend, 4096)
    expect(grid).not.toBeNull()
    expect(straightChord(grid!, 0.5)).toBeLessThan(4096 * Math.SQRT2)
  })

  it('has no grid for a transform with a sample outside the domain', () => {
    const holed: PointTransform = (x, y) => (x === 4096 && y === 4096 ? [Number.NaN, Number.NaN] : [x, y])
    expect(gridImages(holed, 4096)).toBeNull()
  })
})

describe('sourceCoverage', () => {
  /** A field whose samples span a Mercator rectangle given as fractions of the world (y down). */
  function fieldOver(x0: number, y0: number, x1: number, y1: number): MercatorField {
    const field = new Float64Array(FIELD_SIZE * FIELD_SIZE * 2)
    for (let j = 0; j < FIELD_SIZE; j++) {
      for (let i = 0; i < FIELD_SIZE; i++) {
        const k = 2 * (j * FIELD_SIZE + i)
        field[k] = -HALF_WORLD + (x0 + ((x1 - x0) * i) / (FIELD_SIZE - 1)) * WORLD
        field[k + 1] = HALF_WORLD - (y0 + ((y1 - y0) * j) / (FIELD_SIZE - 1)) * WORLD
      }
    }
    return field
  }
  /** Never reached: every sample of these fields has a position. */
  const noSample = (): [number, number] => [Number.NaN, Number.NaN]

  it('records where in a tile the samples fall', () => {
    // Zoom 2: tiles are quarters of the world; the middle half of tile 1/1.
    const field = fieldOver(0.3125, 0.3125, 0.4375, 0.4375)
    const key = tileKey(2, 1, 1)
    const coverage = sourceCoverage(field, 2, noSample)
    expect([...coverage.keys()]).toEqual([key])
    const cover = coverage.get(key)
    expect(cover?.minX).toBeCloseTo(0.25)
    expect(cover?.maxX).toBeCloseTo(0.75)
    expect(cover?.minY).toBeCloseTo(0.25)
    expect(cover?.maxY).toBeCloseTo(0.75)
  })

  it('reaches the shared edge of tiles the samples straddle', () => {
    // Samples over tiles 1/1 and 2/1 at zoom 2.
    const field = fieldOver(0.4, 0.3, 0.6, 0.4)
    const coverage = sourceCoverage(field, 2, noSample)
    expect([...coverage.keys()].sort()).toEqual([tileKey(2, 1, 1), tileKey(2, 2, 1)].sort())
    expect(coverage.get(tileKey(2, 1, 1))?.minX).toBeCloseTo(0.6)
    expect(coverage.get(tileKey(2, 1, 1))?.maxX).toBeCloseTo(1, 1)
    expect(coverage.get(tileKey(2, 2, 1))?.minX).toBeCloseTo(0, 1)
  })

  it('has no entry for a tile the field does not reach, which renderVectorTile then does not read', () => {
    const field = fieldOver(0.3, 0.3, 0.4, 0.4)
    expect(sourceCoverage(field, 2, noSample).get(tileKey(2, 2, 1))).toBeUndefined()
  })
})

describe('vectorMaxZoom', () => {
  it('is the zoom whose tile is no larger than a source tile at maxzoom', () => {
    const crs = buildCrs(6677, PROJJSON[6677])
    const z = vectorMaxZoom(crs, 15, 24)
    const tileMeters = crs.tms.extentAtZoom0 / 2 ** z
    const sourceMeters = (2 * Math.PI * 6378137) / 2 ** 15
    // EPSG:6677 is in meters at scale ~1 near its center.
    expect(tileMeters).toBeLessThanOrEqual(sourceMeters * 1.01)
    expect(tileMeters * 2).toBeGreaterThan(sourceMeters * 0.99)
  })
})
