/**
 * Reprojecting Web Mercator vector tiles into one output tile. The source
 * tiles are chosen as for raster ({@link mercatorField},
 * {@link chooseSourceZoom}) over the output tile plus its buffer; then each
 * source tile's features, pre-clipped to that tile, are transformed from
 * source tile units straight into output tile units, clipped, quantized and
 * merged by layer.
 */

import type { Affine } from '@developmentseed/affine'
import { compose, invert, scale, translation } from '@developmentseed/affine'
import type { ProjectionFunction } from '@developmentseed/proj'
import { nearestCopy } from '@developmentseed/proj'
import type { Crs } from './crs.ts'
import { NO_POSITION } from './crs.ts'
import { HALF_WORLD, MERCATOR_TMS, WORLD } from './mercator.ts'
import { insertTouches, quantizeLine, quantizePolygon } from './mvt/clean.ts'
import type { Rect } from './mvt/clip.ts'
import { clipLine, clipPoints, clipPolygon, clipRing } from './mvt/clip.ts'
import { decodeTile } from './mvt/decode.ts'
import { encodeTile } from './mvt/encode.ts'
import type { Bbox, Coords, Feature, Geometry, Layer, Polygon } from './mvt/geometry.ts'
import { coordinateCount, geometryBbox } from './mvt/geometry.ts'
import type { DensifyOptions, PointTransform } from './mvt/transform.ts'
import { transformLine, transformRing } from './mvt/transform.ts'
import type { TileSource } from './source.ts'
import type { VectorTiming } from './timing.ts'
import { tileAffine } from './tms.ts'
import type { MercatorField } from './warp.ts'
import {
  chooseSourceZoom,
  clamp,
  medianPixelSize,
  mercatorField,
  mercatorPosition,
  mod,
  tileFromKey,
  tileKey,
} from './warp.ts'

/**
 * Output tile extent and buffer, in units. The extent is MapLibre's own grid
 * (its `EXTENT`), so it reads the coordinates unscaled, and twice planetiler's
 * 4096, which halves how far rounding moves a vertex. The buffer is
 * planetiler's 64 at 4096.
 */
export const OUTPUT_EXTENT = 8192
const OUTPUT_BUFFER = 128

/** Segments are kept as they are: see {@link tileTransform}. */
const NO_DENSIFY: DensifyOptions = {
  tolerance: Number.POSITIVE_INFINITY,
  maxDepth: 0,
  maxSegment: Number.POSITIVE_INFINITY,
  minChord: Number.POSITIVE_INFINITY,
}
/**
 * Samples per side of the grid {@link tileTransform} tests a tile on. Fine
 * enough that the bending measured between samples bounds the bending of
 * shorter segments near the Mercator latitude limit, where a world
 * projection's scale changes fastest (a 5-grid let segments at a z0 tile's
 * polar corner bend by 26 units; 9 bounds them at 6).
 */
const SMOOTH_GRID = 9

/**
 * Cells per side of the field that finds the source tiles; its samples are
 * the cells' corners, spanning the output tile and its buffer exactly. It is
 * also the nominal tile size the zoom choice is given, so the chosen source
 * tiles match the output tile's ground size whatever the value. Coarse,
 * since the field only picks the source zoom and bounds the coverage: a
 * tile that contains a pole or the antimeridian computes every sample
 * exactly, at two proj4 calls each.
 */
const FIELD_CELLS = 64
/** Samples per side of that field. Exported for tests. */
export const FIELD_SIZE = FIELD_CELLS + 1
/**
 * Samples per side of the field {@link vectorMaxZoom} measures tile 0/0/0
 * with: finer, since it runs once per CRS and its rounding sets the TileJSON.
 */
const MAX_ZOOM_FIELD_SIZE = 256
/**
 * Source tiles one output tile may read, counted at the field's samples; the
 * zoom is lowered to fit. The cells between samples can touch a few more.
 */
const MAX_SOURCE_TILES = 16
/** Densification: one output unit (half a unit at 4096), 2^8 pieces per segment at most. */
const DENSIFY_TOLERANCE = 1
const DENSIFY_MAX_DEPTH = 8

/** A source tile's features after decoding and pre-clipping, target-independent. */
export interface SourceTile {
  layers: SourceLayer[]
  /** Rough heap size, for bounding a cache by bytes. */
  bytes: number
}

interface SourceLayer {
  name: string
  extent: number
  features: SourceFeature[]
}

interface SourceFeature {
  feature: Feature
  bbox: Bbox
}

/** Rough heap size of a prepared feature: its objects, coordinates and properties. */
function featureBytes(feature: Feature): number {
  let properties = 0
  for (const _ in feature.properties) properties++
  return 160 + 8 * coordinateCount(feature.geometry) + 48 * properties
}

/**
 * Decode a source tile and clip every feature to the tile's own unbuffered
 * extent, so that neighbouring tiles' features abut instead of overlapping:
 * lines and rings to `[0, extent]`, points to the half-open `[0, extent)`.
 */
export function prepareSourceTile(bytes: Uint8Array): SourceTile {
  const decoded = decodeTile(bytes)
  const layers: SourceLayer[] = []
  let size = 64
  for (const layer of decoded) {
    const closed: Rect = { minX: 0, minY: 0, maxX: layer.extent, maxY: layer.extent }
    const halfOpen: Rect = { ...closed, maxX: layer.extent - 1, maxY: layer.extent - 1 }
    const clippedFeatures: Feature[] = []
    for (const feature of layer.features) {
      const geometry = clipGeometry(feature.geometry, closed, halfOpen)
      if (geometry !== null) clippedFeatures.push({ ...feature, geometry })
    }
    const features: SourceFeature[] = []
    for (const feature of clippedFeatures) {
      // Touches become shared vertices, which rounding keeps together.
      const geometry =
        feature.geometry.type === 3
          ? { type: 3 as const, polygons: feature.geometry.polygons.map(insertTouches) }
          : feature.geometry
      const clipped = { ...feature, geometry }
      features.push({ feature: clipped, bbox: geometryBbox(geometry) })
      size += featureBytes(clipped)
    }
    if (features.length) layers.push({ name: layer.name, extent: layer.extent, features })
  }
  return { layers, bytes: size }
}

/** @returns `null` when nothing is left. */
function clipGeometry(geometry: Geometry, rect: Rect, pointRect: Rect): Geometry | null {
  switch (geometry.type) {
    case 1: {
      const points = clipPoints(geometry.points, pointRect)
      return points.length ? { type: 1, points } : null
    }
    case 2: {
      const lines = geometry.lines.flatMap((line) => clipLine(line, rect))
      return lines.length ? { type: 2, lines } : null
    }
    case 3: {
      // Not clipRing: the bridges it leaves along the edge would cross
      // themselves once transformed (see clipPolygon).
      const polygons = geometry.polygons.flatMap((polygon) => clipPolygon(polygon, rect))
      return polygons.length ? { type: 3, polygons } : null
    }
  }
}

type VectorSource = Pick<TileSource, 'minzoom' | 'maxzoom'>

/**
 * Render output tile `z/x/y`: MVT bytes, empty when nothing of the source
 * falls in the tile or the tile is too coarse for the source (it would read
 * too many tiles even at the source's `minzoom`).
 *
 * @param load - a prepared source tile, or `null` where the source has none
 */
export async function renderVectorTile(
  crs: Crs,
  source: VectorSource,
  z: number,
  x: number,
  y: number,
  load: (z: number, x: number, y: number) => Promise<SourceTile | null>,
  timing?: VectorTiming,
): Promise<Uint8Array> {
  let t = timing ? performance.now() : 0
  const toCrs = tileAffine(crs.tms, z, x, y, OUTPUT_EXTENT)
  // The field's samples (at pixel centers, 0.5 apart from the corners) span
  // the tile and its buffer: field px → output units → CRS.
  const cell = (OUTPUT_EXTENT + 2 * OUTPUT_BUFFER) / FIELD_CELLS
  const fieldToOutput = compose(translation(-OUTPUT_BUFFER - cell / 2, -OUTPUT_BUFFER - cell / 2), scale(cell))
  const fieldToCrs = compose(toCrs, fieldToOutput)
  const field = mercatorField(fieldToCrs, FIELD_SIZE, crs.to3857, crs.from3857)
  const choice = chooseSourceZoom(field, FIELD_SIZE, { ...source, tileSize: FIELD_CELLS }, MAX_SOURCE_TILES)
  if (choice === null) {
    if (timing) {
      const t1 = performance.now()
      timing.field = t1 - t
      t = t1
    }
    const empty = encodeTile([])
    if (timing) {
      timing.encode = performance.now() - t
      timing.bytes = empty.byteLength
    }
    return empty
  }
  // The source tiles to read: those the field's cells touch, at the chosen zoom.
  const sampleAt = (i: number, j: number) => mercatorPosition(fieldToCrs, crs.to3857, i + 0.5, j + 0.5)
  const coverage = sourceCoverage(field, choice.z, sampleAt)
  if (timing) {
    const t1 = performance.now()
    timing.field = t1 - t
    t = t1
    timing.sourceZoom = choice.z
    timing.tiles = coverage.size
  }
  const tiles = await Promise.all(
    [...coverage].map(async ([key, cover]) => {
      const [sx, sy] = tileFromKey(choice.z, key)
      return { cover, sx, sy, tile: await load(choice.z, sx, sy) }
    }),
  )
  if (timing) {
    const t1 = performance.now()
    timing.fetch = t1 - t
    t = t1
  }

  const toTile = invert(toCrs)
  const output: Rect = {
    minX: -OUTPUT_BUFFER,
    minY: -OUTPUT_BUFFER,
    maxX: OUTPUT_EXTENT + OUTPUT_BUFFER,
    maxY: OUTPUT_EXTENT + OUTPUT_BUFFER,
  }
  const densify: DensifyOptions = {
    tolerance: DENSIFY_TOLERANCE,
    maxDepth: DENSIFY_MAX_DEPTH,
    // Half the tile matrix set's width, in output units at this zoom.
    maxSegment: (2 ** z * OUTPUT_EXTENT) / 2,
    minChord: 0,
  }
  const layers = new Map<string, Layer>()
  for (const { cover, sx, sy, tile } of tiles) {
    if (tile === null) continue
    // By layer extent (normally one, 4096, for every layer).
    const transforms = new Map<number, TileTransform>()
    for (const layer of tile.layers) {
      let transform = transforms.get(layer.extent)
      if (transform === undefined) {
        transform = tileTransform(crs, toTile, choice.z, sx, sy, layer.extent, densify)
        transforms.set(layer.extent, transform)
      }
      // The part of the source tile the output tile can see, in its units.
      const wanted: Rect = {
        minX: cover.minX * layer.extent,
        minY: cover.minY * layer.extent,
        maxX: cover.maxX * layer.extent,
        maxY: cover.maxY * layer.extent,
      }
      let out = layers.get(layer.name)
      for (const { feature, bbox } of layer.features) {
        if (!overlaps(bbox, wanted)) continue
        // Only what can reach the output tile goes through the projection.
        let visible: Geometry | null
        if (contains(wanted, bbox)) {
          visible = feature.geometry
        } else {
          visible = clipGeometry(feature.geometry, wanted, wanted)
        }
        if (visible === null) continue
        const geometry = reproject(visible, transform, output)
        if (geometry === null) continue
        out ??= { name: layer.name, extent: OUTPUT_EXTENT, features: [] }
        out.features.push({ ...feature, geometry })
      }
      if (out !== undefined) layers.set(layer.name, out)
    }
  }
  if (timing) {
    const t1 = performance.now()
    timing.transform = t1 - t
    t = t1
  }
  const encoded = encodeTile([...layers.values()])
  if (timing) {
    timing.encode = performance.now() - t
    timing.bytes = encoded.byteLength
  }
  return encoded
}

function overlaps(box: Bbox, r: Rect): boolean {
  return box[0] <= r.maxX && box[2] >= r.minX && box[1] <= r.maxY && box[3] >= r.minY
}

function contains(r: Rect, box: Bbox): boolean {
  return box[0] >= r.minX && box[2] <= r.maxX && box[1] >= r.minY && box[3] <= r.maxY
}

/** How one source tile's coordinates become output tile coordinates. */
interface TileTransform {
  f: PointTransform
  densify: DensifyOptions
}

/**
 * The transform for source tile `sz/sx/sy`, from a grid of its points. A
 * tile that lies entirely inside the domain (every grid point has a checked
 * image) needs no per-point inverse check, at half the cost. The grid also
 * tells how long a segment the tile's curvature bends by no more than the
 * tolerance ({@link straightChord}): shorter segments need no midpoint
 * check, and none does when the tile's diagonal is shorter.
 */
function tileTransform(
  crs: Crs,
  toTile: Affine,
  sz: number,
  sx: number,
  sy: number,
  extent: number,
  densify: DensifyOptions,
): TileTransform {
  const checked = composeTransform(crs.from3857Checked, toTile, sz, sx, sy, extent)
  const grid = gridImages(checked, extent)
  // The domain's edge crosses the tile: every point and midpoint is checked.
  if (grid === null) return { f: checked, densify }
  const f = composeTransform(crs.from3857, toTile, sz, sx, sy, extent)
  const minChord = straightChord(grid, densify.tolerance)
  if (minChord >= diagonal(grid)) return { f, densify: NO_DENSIFY }
  return { f, densify: { ...densify, minChord } }
}

/**
 * The checked transform from source tile `sz/sx/sy` units (`extent` per
 * side) to output tile `z/x/y` units ({@link OUTPUT_EXTENT} per side), as
 * {@link tileTransform} builds it. Exported for tests.
 */
export function sourceTransform(
  crs: Crs,
  z: number,
  x: number,
  y: number,
  sz: number,
  sx: number,
  sy: number,
  extent: number,
): PointTransform {
  return composeTransform(crs.from3857Checked, invert(tileAffine(crs.tms, z, x, y, OUTPUT_EXTENT)), sz, sx, sy, extent)
}

/**
 * Source tile units → Mercator (affine) → CRS (`from3857`) → output tile
 * units (`toTile`); `NaN` where the CRS has no position. The affines are
 * applied inline: this runs once per vertex.
 */
function composeTransform(
  from3857: ProjectionFunction,
  toTile: Affine,
  sz: number,
  sx: number,
  sy: number,
  extent: number,
): PointTransform {
  const [a, b, c, d, e, f] = tileAffine(MERCATOR_TMS, sz, sx, sy, extent)
  const [ta, tb, tc, td, te, tf] = toTile
  return (px, py) => {
    const [cx, cy] = from3857(a * px + b * py + c, d * px + e * py + f)
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return NO_POSITION
    return [ta * cx + tb * cy + tc, td * cx + te * cy + tf]
  }
}

/** Images of a {@link SMOOTH_GRID}-square grid of a tile's points, row-major. */
interface GridImages {
  xs: Float64Array
  ys: Float64Array
}

/**
 * The images under `f` of a grid of points over a tile of `extent` units,
 * or `null` when a point has none. Exported for tests.
 */
export function gridImages(f: PointTransform, extent: number): GridImages | null {
  const n = SMOOTH_GRID
  const step = extent / (n - 1)
  const xs = new Float64Array(n * n)
  const ys = new Float64Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [x, y] = f(i * step, j * step)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      xs[j * n + i] = x
      ys[j * n + i] = y
    }
  }
  return { xs, ys }
}

/**
 * The longest segment the transform bends by no more than `tolerance`, as
 * the grid measures it: each sample strays from the chord between its two
 * neighbours by some distance, and a chord's error grows with the square
 * of its length, so a chord `sqrt(tolerance / stray)` times as long as that
 * one strays by the tolerance. The least over the grid, along its rows,
 * columns and both diagonals (bending can differ by direction); `Infinity`
 * for an affine transform. Exported for tests.
 */
export function straightChord({ xs, ys }: GridImages, tolerance: number): number {
  const n = SMOOTH_GRID
  let longest = Number.POSITIVE_INFINITY
  const measure = (k: number, before: number, after: number) => {
    const stray = Math.hypot(xs[k] - (xs[before] + xs[after]) / 2, ys[k] - (ys[before] + ys[after]) / 2)
    if (stray === 0) return
    const chord = Math.hypot(xs[after] - xs[before], ys[after] - ys[before])
    longest = Math.min(longest, chord * Math.sqrt(tolerance / stray))
  }
  for (let j = 0; j < n; j++) {
    for (let i = 1; i < n - 1; i++) {
      measure(j * n + i, j * n + i - 1, j * n + i + 1)
      measure(i * n + j, (i - 1) * n + j, (i + 1) * n + j)
      if (j === 0 || j === n - 1) continue
      measure(j * n + i, (j - 1) * n + i - 1, (j + 1) * n + i + 1)
      measure(j * n + i, (j - 1) * n + i + 1, (j + 1) * n + i - 1)
    }
  }
  return longest
}

/** The longer diagonal of the grid's image: the longest segment the tile can hold. */
function diagonal({ xs, ys }: GridImages): number {
  const n = SMOOTH_GRID
  const last = n * n - 1
  return Math.max(
    Math.hypot(xs[last] - xs[0], ys[last] - ys[0]),
    Math.hypot(xs[n - 1] - xs[last - (n - 1)], ys[n - 1] - ys[last - (n - 1)]),
  )
}

/** Transform, clip to the buffered output tile, quantize; `null` when nothing is left. */
function reproject(geometry: Geometry, { f, densify }: TileTransform, output: Rect): Geometry | null {
  switch (geometry.type) {
    case 1: {
      const points: Coords = []
      for (let i = 0; i < geometry.points.length; i += 2) {
        const [tx, ty] = f(geometry.points[i], geometry.points[i + 1])
        if (Number.isFinite(tx) && Number.isFinite(ty)) points.push(Math.round(tx), Math.round(ty))
      }
      const kept = clipPoints(points, output)
      return kept.length ? { type: 1, points: kept } : null
    }
    case 2: {
      const parts = geometry.lines.flatMap((line) => transformLine(line, f, densify))
      const clipped = parts.flatMap((part) => clipLine(part, output))
      const lines: Coords[] = []
      for (const part of clipped) {
        const q = quantizeLine(part)
        if (q !== null) lines.push(q)
      }
      return lines.length ? { type: 2, lines } : null
    }
    case 3: {
      const polygons: Polygon[] = []
      for (const polygon of geometry.polygons) {
        const exterior = transformRing(polygon.exterior, f, densify)
        if (exterior === null) continue
        const clippedExterior = clipRing(exterior, output)
        if (clippedExterior.length === 0) continue
        const transformedHoles: Coords[] = []
        for (const hole of polygon.holes) {
          const tr = transformRing(hole, f, densify)
          if (tr !== null) transformedHoles.push(tr)
        }
        const holes: Coords[] = []
        for (const tr of transformedHoles) {
          const c = clipRing(tr, output)
          if (c.length) holes.push(c)
        }
        const q = quantizePolygon({ exterior: clippedExterior, holes })
        if (q !== null) polygons.push(q)
      }
      return polygons.length ? { type: 3, polygons } : null
    }
  }
}

/** Bounds of the part of a source tile an output tile sees, as fractions of its width. */
interface Coverage {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A field sample's Mercator position, `NaN` where it has none, at fractional sample indices too. */
type SampleAt = (i: number, j: number) => [number, number]

/** Edges of a field cell, between corners numbered `(j << 1) | i`. */
const CELL_EDGES = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
] as const
/** Bisection steps of {@link reach}: the edge's length over 2^8. */
const REACH_STEPS = 8

/**
 * Where in each source tile the output tile falls, so that features
 * elsewhere in the tile can be skipped (an overzoomed output tile reads a
 * small corner of a source tile): the bounds of the field's cells (a sample
 * and its right, lower and diagonal neighbours) that reach into the tile.
 * Where a cell's corner has no Mercator position (past the latitude limit,
 * or outside the domain), the data ends somewhere along the cell's edges
 * from the corners that have one; those edges are followed to where it
 * ends ({@link reach}). Exported for tests.
 */
export function sourceCoverage(field: MercatorField, z: number, sampleAt: SampleAt): Map<number, Coverage> {
  const n = 2 ** z
  const coverage = new Map<number, Coverage>()
  const cover = (tx: number, ty: number, minX: number, minY: number, maxX: number, maxY: number) => {
    const key = tileKey(z, mod(tx, n), ty)
    const c = coverage.get(key)
    if (c === undefined) {
      coverage.set(key, { minX, minY, maxX, maxY })
    } else {
      c.minX = Math.min(c.minX, minX)
      c.minY = Math.min(c.minY, minY)
      c.maxX = Math.max(c.maxX, maxX)
      c.maxY = Math.max(c.maxY, maxY)
    }
  }
  // Bounds of the cell being visited, in global tile units: x in the copy
  // of the world nearest the positions included so far (a cell may straddle
  // the antimeridian), y clamped to the world's rows.
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  const include = (mx: number, my: number) => {
    let x = ((mx + HALF_WORLD) / WORLD) * n
    if (minX !== Number.POSITIVE_INFINITY) x = nearestCopy(x, minX, n)
    const y = clamp(((HALF_WORLD - my) / WORLD) * n, 0, n)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const positioned = [false, false, false, false]
  for (let j = 0; j + 1 < FIELD_SIZE; j++) {
    for (let i = 0; i + 1 < FIELD_SIZE; i++) {
      minX = Number.POSITIVE_INFINITY
      minY = Number.POSITIVE_INFINITY
      maxX = Number.NEGATIVE_INFINITY
      maxY = Number.NEGATIVE_INFINITY
      for (let corner = 0; corner < 4; corner++) {
        const k = 2 * ((j + (corner >> 1)) * FIELD_SIZE + i + (corner & 1))
        positioned[corner] = !Number.isNaN(field[k])
        if (positioned[corner]) include(field[k], field[k + 1])
      }
      if (minX === Number.POSITIVE_INFINITY) continue
      for (const [a, b] of CELL_EDGES) {
        if (positioned[a] === positioned[b]) continue
        const [from, to] = positioned[a] ? [a, b] : [b, a]
        include(...reach(sampleAt, i + (from & 1), j + (from >> 1), i + (to & 1), j + (to >> 1)))
      }
      // The tiles the bounds span; a tile only touched at its edge is left out.
      const tx0 = Math.floor(minX)
      const tx1 = Math.max(tx0, Math.ceil(maxX) - 1)
      const ty0 = Math.min(n - 1, Math.floor(minY))
      const ty1 = Math.max(ty0, Math.min(n - 1, Math.ceil(maxY) - 1))
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          cover(tx, ty, clamp(minX - tx, 0, 1), clamp(minY - ty, 0, 1), clamp(maxX - tx, 0, 1), clamp(maxY - ty, 0, 1))
        }
      }
    }
  }
  return coverage
}

/**
 * The last position along the field's edge from sample `a`, which has one,
 * towards sample `b`, which has none, by bisection: where the data ends
 * (the latitude limit, a world projection's limb).
 */
function reach(sampleAt: SampleAt, ai: number, aj: number, bi: number, bj: number): [number, number] {
  let last = sampleAt(ai, aj)
  for (let step = 0; step < REACH_STEPS; step++) {
    const mi = (ai + bi) / 2
    const mj = (aj + bj) / 2
    const p = sampleAt(mi, mj)
    if (Number.isNaN(p[0])) {
      bi = mi
      bj = mj
    } else {
      ai = mi
      aj = mj
      last = p
    }
  }
  return last
}

/**
 * The output zoom beyond which a client should overzoom instead of asking:
 * the smallest zoom whose tile is no larger in Mercator meters than a source
 * tile at the source's `maxzoom`, by the tile matrix set's median scale (the
 * same measure the zoom choice uses, which ignores where the CRS has no
 * Mercator position, such as a pole). `maxZoom` if nowhere has one.
 */
export function vectorMaxZoom(crs: Crs, sourceMaxZoom: number, maxZoom: number): number {
  const size = MAX_ZOOM_FIELD_SIZE
  const field = mercatorField(tileAffine(crs.tms, 0, 0, 0, size), size, crs.to3857, crs.from3857)
  const metersPerSample = medianPixelSize(field, size)
  if (Number.isNaN(metersPerSample)) return maxZoom
  // Tile 0/0/0 is `size` samples wide; a tile at zoom z is 2^z times narrower.
  const tile0Meters = size * metersPerSample
  const sourceTileMeters = WORLD / 2 ** sourceMaxZoom
  const z = Math.ceil(Math.log2(tile0Meters / sourceTileMeters))
  return Math.min(maxZoom, Math.max(0, z))
}
