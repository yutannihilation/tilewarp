/** MVT bytes → {@link Layer}s, with polygon ring roles decided here. */

import type { VectorTileFeature } from '@mapbox/vector-tile'
import { classifyRings, VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import type { Coords, Feature, Geometry, Layer, Polygon } from './geometry.ts'

/** The decoder's points (`@mapbox/point-geometry`, not a dependency here). */
type Point = ReturnType<VectorTileFeature['loadGeometry']>[number][number]

export function decodeTile(bytes: Uint8Array): Layer[] {
  const tile = new VectorTile(new PbfReader(bytes))
  const layers: Layer[] = []
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name]
    const features: Feature[] = []
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      const geometry = decodeGeometry(f.type, f.loadGeometry())
      if (geometry === null) continue
      const feature: Feature = { properties: f.properties, geometry }
      if (f.id !== undefined) feature.id = f.id
      features.push(feature)
    }
    layers.push({ name, extent: layer.extent, features })
  }
  return layers
}

function flat(points: Point[]): Coords {
  const coords: Coords = new Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    coords[2 * i] = points[i].x
    coords[2 * i + 1] = points[i].y
  }
  return coords
}

/** A ring without its closing point (the decoder repeats the first one). */
function openRing(points: Point[]): Coords {
  const n = points.length
  const last = points[n - 1]
  const closed = n > 1 && last.x === points[0].x && last.y === points[0].y
  return flat(closed ? points.slice(0, n - 1) : points)
}

/** @returns `null` for unknown or empty geometry. */
function decodeGeometry(type: 0 | 1 | 2 | 3, parts: Point[][]): Geometry | null {
  switch (type) {
    case 1: {
      const points: Coords = []
      for (const part of parts) for (const p of part) points.push(p.x, p.y)
      return points.length ? { type: 1, points } : null
    }
    case 2: {
      const lines = parts.filter((p) => p.length >= 2).map(flat)
      return lines.length ? { type: 2, lines } : null
    }
    case 3: {
      // The source is Web Mercator, so its winding says which rings are
      // exterior: the first ring's orientation, as MapLibre reads it too.
      const polygons: Polygon[] = []
      for (const rings of classifyRings(parts)) {
        if (rings.length === 0) continue
        const [exterior, ...holes] = rings.map(openRing)
        if (exterior.length < 6) continue
        polygons.push({ exterior, holes: holes.filter((h) => h.length >= 6) })
      }
      return polygons.length ? { type: 3, polygons } : null
    }
    default:
      return null
  }
}
