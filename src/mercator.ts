/** Web Mercator (EPSG:3857) constants. */

import type { TileMatrixSet } from './tms.ts'

const EARTH_RADIUS = 6378137
/** Half the width of the Web Mercator world in meters (πR). */
export const HALF_WORLD = Math.PI * EARTH_RADIUS
/** Width of the Web Mercator world in meters (2πR). */
export const WORLD = 2 * HALF_WORLD

/*
 * Global pixel coordinates at zoom z, used by the warp's per-pixel loops:
 *   gx = (mx + HALF_WORLD) * scale - 0.5,  gy = (HALF_WORLD - my) * scale - 0.5
 * with scale = tileSize * 2^z / WORLD, so pixel centers are at integers.
 */

/** Web Mercator as a tile matrix set: tile 0/0/0 is the whole world. */
export const MERCATOR_TMS: TileMatrixSet = { origin: [-HALF_WORLD, HALF_WORLD], extentAtZoom0: WORLD }
