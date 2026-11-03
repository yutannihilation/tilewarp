/**
 * Tile matrix sets in the sense of MapLibre's custom CRS: tile 0/0/0 is the
 * square `origin` (top-left, [x, y]) to `origin + [extent, -extent]`, and each
 * zoom splits every tile into four.
 */

import type { Affine } from '@developmentseed/affine'
import type { Bounds, ProjectionFunction } from '@developmentseed/proj'
import { transformBounds, unwrapBbox } from '@developmentseed/proj'

export interface TileMatrixSet {
  origin: [x: number, y: number]
  extentAtZoom0: number
}

/** Edge densification for projecting the area of use (curved in most CRSs). */
const DENSIFY_POINTS = 101

/**
 * The smallest square holding the area of use projected into the CRS, centered
 * on it.
 *
 * @param areaOfUse - `[west, south, east, north]` degrees; `west > east`
 *   crosses the antimeridian
 * @param fromLngLat - [lng, lat] degrees → CRS [x, y]
 * @throws If the projected bounds are not finite and positive in size.
 */
export function tmsFromAreaOfUse(areaOfUse: Bounds, fromLngLat: ProjectionFunction): TileMatrixSet {
  const [minX, minY, maxX, maxY] = transformBounds(fromLngLat, ...unwrapBbox(areaOfUse), {
    densifyPts: DENSIFY_POINTS,
  })
  const extent = Math.max(maxX - minX, maxY - minY)
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || !(extent > 0)) {
    throw new Error(`Area of use projects to invalid bounds [${minX}, ${minY}, ${maxX}, ${maxY}]`)
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { origin: [cx - extent / 2, cy + extent / 2], extentAtZoom0: extent }
}

/**
 * Affine from tile pixel-corner coordinates (0..tileSize, y down) to CRS
 * coordinates.
 */
export function tileAffine(tms: TileMatrixSet, z: number, x: number, y: number, tileSize: number): Affine {
  const tileExtent = tms.extentAtZoom0 / 2 ** z
  const res = tileExtent / tileSize
  return [res, 0, tms.origin[0] + x * tileExtent, 0, -res, tms.origin[1] - y * tileExtent]
}
