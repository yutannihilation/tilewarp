/** Target CRS: projection functions and the tile matrix set derived for it. */

import type { ProjectionFunction, ProjJson } from '@developmentseed/proj'
import { nearestCopy, parseWkt } from '@developmentseed/proj'
import proj4 from 'proj4'
import { CrsError, UpstreamError } from './errors.ts'
import { memoized } from './memo.ts'
import { WORLD } from './mercator.ts'
import type { TileMatrixSet } from './tms.ts'
import { tmsFromAreaOfUse } from './tms.ts'

/** PROJJSON as served by epsg.io, which adds the area of use. */
export type EpsgProjJson = ProjJson & {
  name?: string
  bbox?: {
    south_latitude: number
    west_longitude: number
    north_latitude: number
    east_longitude: number
  }
}

export interface Crs {
  epsg: number
  projjson: EpsgProjJson
  tms: TileMatrixSet
  /**
   * CRS → EPSG:3857, unclamped. `NaN` where the CRS has no such position:
   * where proj4 cannot place it, or past the edge of a world projection
   * (Equal Earth, say), where proj4's inverse answers with a position
   * elsewhere instead of failing.
   */
  to3857: ProjectionFunction
  /**
   * EPSG:3857 → CRS as proj4 answers, also outside the projection's domain;
   * `NaN` where proj4 throws.
   */
  from3857: ProjectionFunction
  /**
   * {@link from3857}, `NaN` where the CRS has no such position: where proj4
   * fails, or where its answer does not come back to the input (outside the
   * domain). Twice the cost of {@link from3857}.
   */
  from3857Checked: ProjectionFunction
}

/**
 * Largest CRS → 3857 → CRS round-trip error accepted, relative to the tile
 * matrix set's size: far above proj4's iteration tolerances at any zoom, far
 * below the distance a wrapped position lands away.
 */
const ROUND_TRIP_TOLERANCE = 1e-6

/**
 * Largest 3857 → CRS → 3857 round-trip error accepted, in Mercator meters
 * (about 40 m), by the same reasoning.
 */
const MERCATOR_TOLERANCE = ROUND_TRIP_TOLERANCE * WORLD

/** The answer of a projection that has none; shared, never mutated. */
export const NO_POSITION: [number, number] = [Number.NaN, Number.NaN]

/**
 * `f`, except `NaN` where it throws: some proj4 projections (Bonne's
 * inverse, say) throw outside their domain instead of answering `NaN`.
 */
function orNoPosition(f: ProjectionFunction): ProjectionFunction {
  return (x, y) => {
    try {
      return f(x, y)
    } catch {
      return NO_POSITION
    }
  }
}

/**
 * `forward`, except `NaN` where its answer is not finite or where `inverse`
 * does not take it back to within `close` of the input.
 */
function roundTripped(
  forward: ProjectionFunction,
  inverse: ProjectionFunction,
  close: (x: number, y: number, backX: number, backY: number) => boolean,
): ProjectionFunction {
  return (x, y) => {
    const p = forward(x, y)
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return NO_POSITION
    const [backX, backY] = inverse(p[0], p[1])
    return close(x, y, backX, backY) ? p : NO_POSITION
  }
}

/** Build a {@link Crs}. Pure apart from proj4's global definition cache. */
export function buildCrs(epsg: number, projjson: EpsgProjJson): Crs {
  // A geocentric CRS (X/Y/Z from the Earth's center) has no plane to tile:
  // X/Y without Z land on the equatorial plane, so every position would fail.
  // Compound and bound CRSs from epsg.io have no top-level coordinate system.
  if (projjson.coordinate_system?.axis.some((a) => a.direction.startsWith('geocentric'))) {
    throw new CrsError(`EPSG:${epsg} is a geocentric CRS, not a map projection`)
  }
  if (!projjson.bbox) {
    throw new CrsError(`EPSG:${epsg} has no area of use to derive a tile matrix set from`)
  }
  const { west_longitude, south_latitude, east_longitude, north_latitude } = projjson.bbox

  const def = parseWkt(projjson)
  // proj4's typings don't cover wkt-parser output, which it accepts at runtime.
  // @ts-expect-error - incomplete proj4 typings
  const fromLngLat = proj4('EPSG:4326', def)
  // @ts-expect-error - incomplete proj4 typings
  const to3857Converter = proj4(def, 'EPSG:3857')

  type Point = [number, number]
  const tms = tmsFromAreaOfUse([west_longitude, south_latitude, east_longitude, north_latitude], (x, y) =>
    fromLngLat.forward<Point>([x, y], false),
  )
  const from3857 = orNoPosition((x, y) => to3857Converter.inverse<Point>([x, y], false))
  const rawTo3857 = orNoPosition((x, y) => to3857Converter.forward<Point>([x, y], false))
  const tolerance = ROUND_TRIP_TOLERANCE * tms.extentAtZoom0
  const to3857 = roundTripped(rawTo3857, from3857, (x, y, bx, by) => Math.hypot(bx - x, by - y) <= tolerance)
  const from3857Checked = roundTripped(from3857, rawTo3857, (x, y, bx, by) => {
    // A longitude wrapped by proj4 comes back a world away in x.
    return Math.hypot(nearestCopy(bx, x, WORLD) - x, by - y) <= MERCATOR_TOLERANCE
  })
  return { epsg, projjson, tms, to3857, from3857, from3857Checked }
}

/**
 * How epsg.io is fetched: the runtime's `fetch`, with whatever caching
 * options the caller's runtime offers.
 */
export type FetchJson = (url: string) => Promise<Response>

/**
 * @throws {CrsError} If epsg.io does not know the code.
 * @throws {UpstreamError} If epsg.io answers with an error or with a body that is not JSON.
 */
export async function fetchEpsgProjJson(epsg: number, fetchJson: FetchJson): Promise<EpsgProjJson> {
  const url = `https://epsg.io/${epsg}.json`
  const resp = await fetchJson(url)
  if (resp.status === 404) {
    throw new CrsError(`Unknown CRS EPSG:${epsg}`)
  }
  if (!resp.ok) {
    throw new UpstreamError(`Failed to fetch ${url}: HTTP ${resp.status}`)
  }
  try {
    return (await resp.json()) as EpsgProjJson
  } catch (error) {
    throw new UpstreamError(`Failed to read JSON from ${url}`, { cause: error })
  }
}

const CRS_CACHE = new Map<number, Promise<Crs>>()

/**
 * {@link buildCrs} for a code, memoized per isolate by code alone (so every
 * caller should pass the same `fetchJson`); failures are not kept.
 */
export function resolveCrs(epsg: number, fetchJson: FetchJson): Promise<Crs> {
  return memoized(CRS_CACHE, epsg, async () => buildCrs(epsg, await fetchEpsgProjJson(epsg, fetchJson)))
}
