/**
 * CPU warp of Web Mercator tiles into one output tile, in the manner of
 * gdalwarp's approximate transformer.
 *
 * 1. {@link mercatorField}: a `RasterReprojector` mesh over the output tile
 *    approximates output pixel → EPSG:3857 within `MAX_ERROR` output pixels,
 *    and each output pixel center gets its Mercator position by barycentric
 *    interpolation. Pixels the mesh cannot represent (in a tile containing a
 *    pole, the antimeridian or points the CRS cannot place, or in a triangle
 *    with such a vertex) are computed with the exact transform instead.
 * 2. {@link chooseSourceZoom}: which source tiles to fetch.
 * 3. {@link sampleField}: bilinear sampling of the source tiles.
 */

import type { Affine } from '@developmentseed/affine'
import { apply, invert } from '@developmentseed/affine'
import type { ProjectionFunction } from '@developmentseed/proj'
import { RasterReprojector } from '@developmentseed/raster-reproject'
import { HALF_WORLD, WORLD } from './mercator.ts'
import type { RgbaImage } from './png.ts'
import type { TileSource } from './source.ts'

/** Maximum mesh error, in output pixels. */
const MAX_ERROR = 0.125

/** Barycentric tolerance so pixel centers on shared edges are not missed. */
const EDGE_EPSILON = 1e-9

/** Grid of exact samples {@link isMeshable} checks, per side. */
const MESHABLE_GRID = 17

/**
 * Mercator position of each output pixel center: `[x0, y0, x1, y1, ...]`,
 * row-major. `NaN` where the pixel has no position in Web Mercator (outside
 * the projection's domain, or past Web Mercator's latitude limit).
 */
export type MercatorField = Float64Array

/** Whether a position from `to3857` is a point of the Web Mercator world. */
function inMercator(mx: number, my: number): boolean {
  return Number.isFinite(mx) && Math.abs(my) <= HALF_WORLD
}

/**
 * Mercator position of output pixel coordinates `px, py` (corners at
 * integers), `NaN` where there is none, as {@link mercatorField} holds it.
 *
 * @param affine - output pixel corner (0..size, y down) → target CRS
 * @param to3857 - target CRS → EPSG:3857, unclamped, `NaN` where the CRS has
 *   no such position
 */
export function mercatorPosition(affine: Affine, to3857: ProjectionFunction, px: number, py: number): [number, number] {
  const [cx, cy] = apply(affine, px, py)
  const [mx, my] = to3857(cx, cy)
  return inMercator(mx, my) ? [mx, my] : [Number.NaN, Number.NaN]
}

/**
 * @param affine - output pixel corner (0..size, y down) → target CRS
 * @param to3857 - target CRS → EPSG:3857, unclamped, `NaN` where the CRS has
 *   no such position
 * @param from3857 - EPSG:3857 → target CRS
 */
export function mercatorField(
  affine: Affine,
  size: number,
  to3857: ProjectionFunction,
  from3857: ProjectionFunction,
): MercatorField {
  const exact = (px: number, py: number) => {
    const [cx, cy] = apply(affine, px, py)
    return to3857(cx, cy)
  }
  const field = new Float64Array(size * size * 2).fill(Number.NaN)
  // Pixels the mesh interpolated; the rest are computed exactly at the end.
  const done = new Uint8Array(size * size)

  if (isMeshable(exact, size)) {
    interpolateMesh(affine, size, to3857, from3857, field, done)
  }

  for (let k = 0; k < done.length; k++) {
    if (done[k]) continue
    const [mx, my] = mercatorPosition(affine, to3857, (k % size) + 0.5, Math.floor(k / size) + 0.5)
    field[2 * k] = mx
    field[2 * k + 1] = my
  }
  return field
}

/**
 * Fill `field` at the pixel centers inside the mesh's triangles that the
 * linear approximation can represent, marking them in `done`. Triangles
 * with a vertex outside Web Mercator or spanning the antimeridian are left
 * for the exact transform.
 */
function interpolateMesh(
  affine: Affine,
  size: number,
  to3857: ProjectionFunction,
  from3857: ProjectionFunction,
  field: MercatorField,
  done: Uint8Array,
): void {
  const inverse = invert(affine)
  // Mesh vertices are pixel corners, hence size + 1 (see the reference
  // maplibre-warp `buildTileMesh`).
  const reprojector = new RasterReprojector(
    {
      forwardTransform: (px, py) => apply(affine, px, py),
      inverseTransform: (x, y) => apply(inverse, x, y),
      forwardReproject: to3857,
      inverseReproject: from3857,
    },
    size + 1,
    size + 1,
  )
  reprojector.run(MAX_ERROR)
  const { uvs, exactOutputPositions: merc, triangles } = reprojector

  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t]
    const b = triangles[t + 1]
    const c = triangles[t + 2]
    const mAx = merc[2 * a]
    const mAy = merc[2 * a + 1]
    const mBx = merc[2 * b]
    const mBy = merc[2 * b + 1]
    const mCx = merc[2 * c]
    const mCy = merc[2 * c + 1]
    if (
      !inMercator(mAx, mAy) ||
      !inMercator(mBx, mBy) ||
      !inMercator(mCx, mCy) ||
      Math.max(mAx, mBx, mCx) - Math.min(mAx, mBx, mCx) >= HALF_WORLD
    ) {
      continue
    }

    const ax = uvs[2 * a] * size
    const ay = uvs[2 * a + 1] * size
    const bx = uvs[2 * b] * size
    const by = uvs[2 * b + 1] * size
    const cx = uvs[2 * c] * size
    const cy = uvs[2 * c + 1] * size
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (det === 0) continue

    // Pixel centers (i + 0.5, j + 0.5) inside the triangle's bounding box.
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5))
    const i1 = Math.min(size - 1, Math.floor(Math.max(ax, bx, cx) - 0.5))
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5))
    const j1 = Math.min(size - 1, Math.floor(Math.max(ay, by, cy) - 0.5))
    for (let j = j0; j <= j1; j++) {
      const py = j + 0.5
      for (let i = i0; i <= i1; i++) {
        const k = j * size + i
        if (done[k]) continue
        const px = i + 0.5
        const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det
        const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det
        const wc = 1 - wa - wb
        if (wa < -EDGE_EPSILON || wb < -EDGE_EPSILON || wc < -EDGE_EPSILON) continue
        field[2 * k] = wa * mAx + wb * mBx + wc * mCx
        field[2 * k + 1] = wa * mAy + wb * mBy + wc * mCy
        done[k] = 1
      }
    }
  }
}

/**
 * Whether the tile's Mercator positions are continuous enough to mesh: on a
 * grid of exact samples, every one is in Web Mercator, and no two neighbors
 * are across the antimeridian. The reprojector cannot refine across a pole
 * or a seam.
 */
function isMeshable(exact: (px: number, py: number) => [number, number], size: number): boolean {
  const n = MESHABLE_GRID
  const xs = new Float64Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [mx, my] = exact((i * size) / (n - 1), (j * size) / (n - 1))
      if (!inMercator(mx, my)) return false
      xs[j * n + i] = mx
      if (i > 0 && Math.abs(mx - xs[j * n + i - 1]) > HALF_WORLD) return false
      if (j > 0 && Math.abs(mx - xs[(j - 1) * n + i]) > HALF_WORLD) return false
    }
  }
  return true
}

/** Sampling step of {@link medianPixelSize}, in pixels. */
const PIXEL_SIZE_STRIDE = 4

/**
 * Median size of one output pixel in Mercator meters, from the differences
 * to each pixel's right and lower neighbors. `NaN` if no pixel has one.
 */
export function medianPixelSize(field: MercatorField, size: number): number {
  const sizes = new Float64Array(Math.ceil((size - 1) / PIXEL_SIZE_STRIDE) ** 2)
  let count = 0
  for (let j = 0; j < size - 1; j += PIXEL_SIZE_STRIDE) {
    for (let i = 0; i < size - 1; i += PIXEL_SIZE_STRIDE) {
      const k = 2 * (j * size + i)
      const r = k + 2
      const d = k + 2 * size
      const det =
        (field[r] - field[k]) * (field[d + 1] - field[k + 1]) - (field[r + 1] - field[k + 1]) * (field[d] - field[k])
      const s = Math.sqrt(Math.abs(det))
      if (Number.isFinite(s) && s > 0) sizes[count++] = s
    }
  }
  if (count === 0) return Number.NaN
  const valid = sizes.subarray(0, count).sort()
  return valid[count >> 1]
}

/** Key of source tile `x`, `y` at zoom `z`; see {@link tileFromKey}. */
export function tileKey(z: number, x: number, y: number): number {
  return y * 2 ** z + x
}

export function tileFromKey(z: number, key: number): [x: number, y: number] {
  const n = 2 ** z
  return [key % n, Math.floor(key / n)]
}

/*
 * Global texel coordinates span `extent` = 2^z * tileSize texels per side.
 * Columns wrap across the antimeridian and rows clamp to the world's edge;
 * fetching (sourceTileKeys) and sampling (sampleField) must agree on this.
 */
function wrapColumn(x: number, extent: number): number {
  return mod(x, extent)
}

function clampRow(y: number, extent: number): number {
  return clamp(y, 0, extent - 1)
}

/** {@link tileKey} of the tile holding wrapped/clamped texel `gx`, `gy`. */
function tileKeyOfTexel(z: number, tileSize: number, gx: number, gy: number): number {
  return tileKey(z, Math.floor(gx / tileSize), Math.floor(gy / tileSize))
}

/** Keys ({@link tileKey}) of the source tiles a field samples at zoom `z`. */
function sourceTileKeys(field: MercatorField, z: number, tileSize: number): Set<number> {
  const n = 2 ** z
  const extent = n * tileSize
  const scale = extent / WORLD
  const keys = new Set<number>()
  // Neighboring pixels nearly always land in the same tile.
  let lastKey = -1
  for (let k = 0; k < field.length; k += 2) {
    const mx = field[k]
    if (Number.isNaN(mx)) continue
    // Global pixel coordinates; see mercator.ts.
    const x0 = wrapColumn(Math.floor((mx + HALF_WORLD) * scale - 0.5), extent)
    const y0 = Math.floor((HALF_WORLD - field[k + 1]) * scale - 0.5)
    const tx = Math.floor(x0 / tileSize)
    const ty = Math.floor(y0 / tileSize)
    if (x0 - tx * tileSize < tileSize - 1 && y0 >= 0 && y0 - ty * tileSize < tileSize - 1 && ty < n) {
      // The 2x2 texel block bilinear sampling reads is inside one tile.
      const key = ty * n + tx
      if (key !== lastKey) {
        keys.add(key)
        lastKey = key
      }
      continue
    }
    const x1 = wrapColumn(x0 + 1, extent)
    for (const gy of [clampRow(y0, extent), clampRow(y0 + 1, extent)]) {
      keys.add(tileKeyOfTexel(z, tileSize, x0, gy))
      keys.add(tileKeyOfTexel(z, tileSize, x1, gy))
    }
    lastKey = -1
  }
  return keys
}

/**
 * The deepest source zoom read: {@link tileKey} is exact while `4^z` stays
 * within `Number.MAX_SAFE_INTEGER`. A z26 tile is about 60 cm wide.
 */
const MAX_SOURCE_ZOOM = 26

/**
 * The source zoom to sample: the one nearest to the output pixels'
 * resolution, clamped to `[minzoom, maxzoom]` (and to {@link MAX_SOURCE_ZOOM}),
 * then lowered while it would need more than `maxTiles` tiles. Nearest rather
 * than the next finer one keeps a cartographic basemap's labels and symbols
 * within 0.71x-1.41x of their designed size (the next finer zoom would draw
 * them at 0.5x-1x).
 *
 * @returns `null` when the field has no pixel in Web Mercator, or when even
 *   the source's `minzoom` needs more than `maxTiles` tiles (the output tile
 *   is coarser than the source serves, as below a source's `minzoom` in MapLibre).
 */
export function chooseSourceZoom(
  field: MercatorField,
  size: number,
  source: Pick<TileSource, 'minzoom' | 'maxzoom' | 'tileSize'>,
  maxTiles: number,
): { z: number; keys: Set<number> } | null {
  const pixelSize = medianPixelSize(field, size)
  if (Number.isNaN(pixelSize)) return null
  const ideal = Math.round(Math.log2(WORLD / (source.tileSize * pixelSize)))
  let z = clamp(ideal, source.minzoom, Math.min(source.maxzoom, MAX_SOURCE_ZOOM))
  let keys = sourceTileKeys(field, z, source.tileSize)
  while (keys.size > maxTiles && z > source.minzoom) {
    z--
    keys = sourceTileKeys(field, z, source.tileSize)
  }
  if (keys.size > maxTiles) return null
  return { z, keys }
}

/**
 * Bilinearly sample source tiles at each field position into an RGBA tile,
 * with premultiplied alpha so missing tiles do not darken edges.
 *
 * @param tiles - decoded tiles by {@link tileKey}; `null` or absent is transparent
 */
export function sampleField(
  field: MercatorField,
  size: number,
  z: number,
  tileSize: number,
  tiles: ReadonlyMap<number, RgbaImage | null>,
): RgbaImage {
  const n = 2 ** z
  const extent = n * tileSize
  const scale = extent / WORLD
  const rowBytes = tileSize * 4
  const out = new Uint8Array(size * size * 4)

  // Neighboring pixels nearly always read the same tile.
  let lastKey = -1
  let lastData: Uint8Array | undefined
  const tileData = (key: number) => {
    if (key !== lastKey) {
      lastKey = key
      lastData = tiles.get(key)?.data
    }
    return lastData
  }

  for (let k = 0; k < size * size; k++) {
    const mx = field[2 * k]
    if (Number.isNaN(mx)) continue
    // Global pixel coordinates; see mercator.ts.
    const gx = (mx + HALF_WORLD) * scale - 0.5
    const gy = (HALF_WORLD - field[2 * k + 1]) * scale - 0.5
    const fx0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - fx0
    const fy = gy - y0
    const x0 = wrapColumn(fx0, extent)
    const tx = Math.floor(x0 / tileSize)
    const ty = Math.floor(y0 / tileSize)
    const lx = x0 - tx * tileSize
    const ly = y0 - ty * tileSize
    const w00 = (1 - fx) * (1 - fy)
    const w10 = fx * (1 - fy)
    const w01 = (1 - fx) * fy
    const w11 = fx * fy
    let r = 0
    let g = 0
    let b = 0
    let a = 0

    if (lx < tileSize - 1 && y0 >= 0 && ly < tileSize - 1 && ty < n) {
      // Common case: the 2x2 texel block is inside one tile.
      const d = tileData(ty * n + tx)
      if (!d) continue
      const i00 = ly * rowBytes + lx * 4
      const i10 = i00 + 4
      const i01 = i00 + rowBytes
      const i11 = i01 + 4
      const a00 = d[i00 + 3] * w00
      const a10 = d[i10 + 3] * w10
      const a01 = d[i01 + 3] * w01
      const a11 = d[i11 + 3] * w11
      a = a00 + a10 + a01 + a11
      r = d[i00] * a00 + d[i10] * a10 + d[i01] * a01 + d[i11] * a11
      g = d[i00 + 1] * a00 + d[i10 + 1] * a10 + d[i01 + 1] * a01 + d[i11 + 1] * a11
      b = d[i00 + 2] * a00 + d[i10 + 2] * a10 + d[i01 + 2] * a01 + d[i11 + 2] * a11
    } else {
      // The block straddles tiles, the antimeridian or the world's edge.
      const x1 = wrapColumn(x0 + 1, extent)
      for (let dy = 0; dy <= 1; dy++) {
        const row = clampRow(y0 + dy, extent)
        for (let dx = 0; dx <= 1; dx++) {
          const w = dy ? (dx ? w11 : w01) : dx ? w10 : w00
          if (w === 0) continue
          const col = dx ? x1 : x0
          const d = tileData(tileKeyOfTexel(z, tileSize, col, row))
          if (!d) continue
          const i = (row % tileSize) * rowBytes + (col % tileSize) * 4
          const aw = d[i + 3] * w
          r += d[i] * aw
          g += d[i + 1] * aw
          b += d[i + 2] * aw
          a += aw
        }
      }
    }
    if (a === 0) continue
    const o = k * 4
    out[o] = Math.round(r / a)
    out[o + 1] = Math.round(g / a)
    out[o + 2] = Math.round(b / a)
    out[o + 3] = Math.round(a)
  }
  return { width: size, height: size, data: out }
}

export function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
