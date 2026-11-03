/**
 * Vector tile features between decode and encode. Coordinates are flat
 * `[x0, y0, x1, y1, ...]` arrays in tile units (integers from the decoder,
 * doubles in between, integers again for the encoder). Rings are open: the
 * first point is not repeated at the end.
 */

export type Coords = number[]

/** Exterior and interior roles decided at decode time; see {@link classifyRings}. */
export interface Polygon {
  exterior: Coords
  holes: Coords[]
}

export type Geometry = { type: 1; points: Coords } | { type: 2; lines: Coords[] } | { type: 3; polygons: Polygon[] }

export type PropertyValue = string | number | boolean

export interface Feature {
  id?: number
  properties: Record<string, PropertyValue>
  geometry: Geometry
}

export interface Layer {
  name: string
  extent: number
  features: Feature[]
}

/**
 * Twice the signed area of a ring, by the MVT spec's surveyor's formula in
 * y-down tile coordinates: positive for an exterior ring, negative for a hole.
 */
export function signedArea2(ring: Coords): number {
  let sum = 0
  const n = ring.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    sum += (ring[j] - ring[i]) * (ring[i + 1] + ring[j + 1])
  }
  return sum
}

/** Reverse a ring's points in place. */
export function reverse(coords: Coords): void {
  for (let i = 0, j = coords.length - 2; i < j; i += 2, j -= 2) {
    const x = coords[i]
    const y = coords[i + 1]
    coords[i] = coords[j]
    coords[i + 1] = coords[j + 1]
    coords[j] = x
    coords[j + 1] = y
  }
}

/** Number of coordinate values (twice the points) in a geometry. */
export function coordinateCount(geometry: Geometry): number {
  let n = 0
  switch (geometry.type) {
    case 1:
      return geometry.points.length
    case 2:
      for (const line of geometry.lines) n += line.length
      return n
    case 3:
      for (const polygon of geometry.polygons) {
        n += polygon.exterior.length
        for (const hole of polygon.holes) n += hole.length
      }
      return n
  }
}

/** `[minX, minY, maxX, maxY]`; inverted (infinite) when there are no points. */
export type Bbox = [number, number, number, number]

function emptyBbox(): Bbox {
  return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
}

function extend(box: Bbox, coords: Coords): void {
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i]
    const y = coords[i + 1]
    if (x < box[0]) box[0] = x
    if (x > box[2]) box[2] = x
    if (y < box[1]) box[1] = y
    if (y > box[3]) box[3] = y
  }
}

export function bbox(coords: Coords): Bbox {
  const box = emptyBbox()
  extend(box, coords)
  return box
}

/** Bounding box of a whole geometry (of the exteriors, for polygons). */
export function geometryBbox(geometry: Geometry): Bbox {
  const box = emptyBbox()
  switch (geometry.type) {
    case 1:
      extend(box, geometry.points)
      break
    case 2:
      for (const line of geometry.lines) extend(box, line)
      break
    case 3:
      for (const polygon of geometry.polygons) extend(box, polygon.exterior)
      break
  }
  return box
}
