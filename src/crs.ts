/** Target CRS: projection functions and the tile matrix set derived for it. */

import type { ProjectionFunction, ProjJson } from '@developmentseed/proj'
import { nearestCopy, parseWkt } from '@developmentseed/proj'
import proj4 from 'proj4'
import { CrsError, UpstreamError } from './errors.ts'
import { memoized } from './memo.ts'
import { HALF_WORLD, WORLD } from './mercator.ts'
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
  /**
   * Web Mercator x (meters) of the meridian along which the CRS cuts the
   * world open, where positions on its two sides land apart (the meridian
   * opposite an Equal Earth's center, or a cone's cut); `null` when there is
   * none, or none that is a single meridian.
   */
  seam: number | null
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

/** Steps per parallel that {@link seamOnParallel} walks, a degree each. */
const SEAM_SAMPLES = 360
/**
 * Mercator y of the parallels {@link findSeam} searches (about 47°S, 9°N and
 * 58°N): in both hemispheres and away from the poles, where a cone's cut
 * closes up.
 */
const SEAM_PARALLELS = [-6e6, 1e6, 8e6]
/** A step this many times its parallel's median step is looked into. */
const SEAM_CANDIDATE = 4
/** Halvings of a candidate step's interval: from a degree to far below a millimeter. */
const SEAM_HALVINGS = 60
/** A step still this long after the halvings, relative to the tile matrix set's size, is a seam. */
const SEAM_JUMP = 1e-4
/** Largest difference, in Mercator meters, between the parallels' answers for one meridian. */
const SEAM_AGREEMENT = 1e-3

/**
 * Mercator meters to keep clear of {@link Crs.seam} on each side when
 * cutting geometry there. proj4 answers on one fixed side for a point within
 * a micrometer of the seam (it wraps longitudes only beyond a value slightly
 * over π), so geometry cut exactly on it would have ends on the wrong side.
 * A centimeter is under a fiftieth of a source tile unit at zoom 14.
 */
export const SEAM_MARGIN = 0.01

function distance(p: [number, number], q: [number, number]): number {
  return Math.hypot(q[0] - p[0], q[1] - p[1])
}

/**
 * The Mercator x where `from3857` is discontinuous along the parallel at
 * `y`, or `null` unless there is exactly one such place. The parallel is
 * walked in steps; a step much longer than the rest is halved towards its
 * longer half until the interval is tiny. A continuous map's step shrinks
 * with its interval, a seam's does not.
 */
function seamOnParallel(from3857: ProjectionFunction, y: number, extentAtZoom0: number): number | null {
  const width = WORLD / SEAM_SAMPLES
  const images: [number, number][] = []
  for (let i = 0; i <= SEAM_SAMPLES; i++) images.push(from3857(i * width - HALF_WORLD, y))
  const steps = images.slice(1).map((p, i) => distance(images[i], p))
  // A step from or to a point without a finite image is the domain's edge,
  // not a seam: it is left out of the median and is never a candidate.
  const finite = steps.filter(Number.isFinite).sort((a, b) => a - b)
  const median = finite[finite.length >> 1]
  let seam: number | null = null
  for (let i = 0; i < steps.length; i++) {
    if (!Number.isFinite(steps[i]) || steps[i] <= SEAM_CANDIDATE * median) continue
    let a = i * width - HALF_WORLD
    let b = a + width
    let pa = images[i]
    let pb = images[i + 1]
    for (let k = 0; k < SEAM_HALVINGS; k++) {
      const m = (a + b) / 2
      const pm = from3857(m, y)
      if (distance(pa, pm) > distance(pm, pb)) {
        b = m
        pb = pm
      } else {
        a = m
        pa = pm
      }
    }
    const jump = distance(pa, pb)
    if (!Number.isFinite(jump) || jump <= SEAM_JUMP * extentAtZoom0) continue
    if (seam !== null) return null
    seam = (a + b) / 2
  }
  return seam
}

/**
 * The Mercator x of the meridian `from3857` is discontinuous along, or
 * `null`. Every parallel must find one seam ({@link seamOnParallel}), on the
 * same meridian: a jump that only some parallels meet (an oblique
 * projection's) is not a meridian to cut along.
 */
function findSeam(from3857: ProjectionFunction, extentAtZoom0: number): number | null {
  let seam: number | null = null
  for (const y of SEAM_PARALLELS) {
    const found = seamOnParallel(from3857, y, extentAtZoom0)
    if (found === null) return null
    if (seam !== null && Math.abs(found - seam) > SEAM_AGREEMENT) return null
    seam ??= found
  }
  return seam
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
  const seam = findSeam(from3857, tms.extentAtZoom0)
  return { epsg, projjson, tms, to3857, from3857, from3857Checked, seam }
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
