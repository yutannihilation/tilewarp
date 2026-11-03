/**
 * Quantizing transformed coordinates to integers and fixing what that
 * breaks. The arrays are rounded in place: they are the caller's to give up.
 * {@link insertTouches} prepares source polygons for it.
 */

import type { Coords, Polygon } from './geometry.ts'
import { reverse, signedArea2 } from './geometry.ts'

/** Round a polyline to integers in place, dropping repeated points. `null` if < 2 remain. */
export function quantizeLine(line: Coords): Coords | null {
  const out = dedupe(line)
  return out.length >= 4 ? out : null
}

/**
 * Round an open ring to integers in place, drop repeated points (including a
 * last point equal to the first), and give it the winding its role requires.
 * `null` if fewer than 3 points or no area remain.
 */
export function quantizeRing(ring: Coords, exterior: boolean): Coords | null {
  const out = dedupe(ring)
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) {
    out.length -= 2
  }
  if (out.length < 6) return null
  const area = signedArea2(out)
  if (area === 0) return null
  if (area > 0 !== exterior) reverse(out)
  return out
}

/** A polygon's rings quantized; `null` if its exterior is gone. */
export function quantizePolygon(polygon: Polygon): Polygon | null {
  const exterior = quantizeRing(polygon.exterior, true)
  if (exterior === null) return null
  const holes: Coords[] = []
  for (const hole of polygon.holes) {
    const q = quantizeRing(hole, false)
    if (q !== null) holes.push(q)
  }
  return { exterior, holes }
}

/**
 * Add every vertex of a polygon that lies inside one of its edges (in any of
 * its rings) to that edge, in order along it. A touch, such as a hole's
 * vertex on the exterior, then becomes a shared vertex: the transform and
 * rounding move both copies alike, while a vertex on an edge can end up on
 * either side of it, and the rings cross. Exact for integer coordinates; on
 * an edge a clip cut (a fractional end), up to float error.
 *
 * @returns `polygon` itself when nothing touches.
 */
export function insertTouches(polygon: Polygon): Polygon {
  const rings = [polygon.exterior, ...polygon.holes]
  let grid: VertexGrid | undefined
  let changed = false
  const out = rings.map((ring) => {
    // Built only once the ring gains a point.
    let result: Coords | undefined
    for (let i = 0; i < ring.length; i += 2) {
      const ax = ring[i]
      const ay = ring[i + 1]
      result?.push(ax, ay)
      const j = (i + 2) % ring.length
      const dx = ring[j] - ax
      const dy = ring[j + 1] - ay
      // An edge between integer points has gcd(|dx|, |dy|) - 1 integer points
      // inside it, so most have none. The only fractional vertices are where
      // the pre-clip cut an edge, on the tile's border, which an integer edge
      // of a simple polygon can't pass through.
      if (Number.isInteger(ax) && Number.isInteger(ay) && Number.isInteger(dx) && Number.isInteger(dy)) {
        if (gcd(Math.abs(dx), Math.abs(dy)) < 2) continue
      }
      grid ??= vertexGrid(rings)
      const found = touchesOf(grid, ax, ay, ring[j], ring[j + 1])
      if (found === null) continue
      result ??= ring.slice(0, i + 2)
      for (const p of found) result.push(grid.points[p], grid.points[p + 1])
      changed = true
    }
    return result ?? ring
  })
  return changed ? { exterior: out[0], holes: out.slice(1) } : polygon
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const r = a % b
    a = b
    b = r
  }
  return a
}

/**
 * A polygon's vertices bucketed into about two per cell of a square grid
 * over their bounds: `points` (x, y pairs) in cell order, `starts[c]` the
 * first of cell `c` (`starts[cells]` the end).
 */
interface VertexGrid {
  points: Float64Array
  starts: Int32Array
  side: number
  minX: number
  minY: number
  cellW: number
  cellH: number
}

function vertexGrid(rings: Coords[]): VertexGrid {
  let n = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const ring of rings) {
    n += ring.length / 2
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i])
      maxX = Math.max(maxX, ring[i])
      minY = Math.min(minY, ring[i + 1])
      maxY = Math.max(maxY, ring[i + 1])
    }
  }
  const side = Math.max(1, Math.round(Math.sqrt(n / 2)))
  const grid = {
    points: new Float64Array(2 * n),
    starts: new Int32Array(side * side + 1),
    side,
    minX,
    minY,
    cellW: (maxX - minX) / side || 1,
    cellH: (maxY - minY) / side || 1,
  }
  // Counting sort by cell.
  const cells = new Int32Array(n)
  let k = 0
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const c = cellIndex(grid, ring[i], ring[i + 1])
      cells[k++] = c
      grid.starts[c + 1]++
    }
  }
  for (let c = 0; c < side * side; c++) grid.starts[c + 1] += grid.starts[c]
  const next = grid.starts.slice(0, side * side)
  k = 0
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const at = 2 * next[cells[k++]]++
      grid.points[at] = ring[i]
      grid.points[at + 1] = ring[i + 1]
    }
  }
  return grid
}

function cellIndex(grid: VertexGrid, x: number, y: number): number {
  return cellRow(grid, y) * grid.side + cellColumn(grid, x)
}

function cellColumn(grid: VertexGrid, x: number): number {
  return Math.min(grid.side - 1, Math.floor((x - grid.minX) / grid.cellW))
}

function cellRow(grid: VertexGrid, y: number): number {
  return Math.min(grid.side - 1, Math.floor((y - grid.minY) / grid.cellH))
}

/**
 * Offsets into `grid.points` of the distinct vertices strictly inside the
 * edge a → b, in order from a; `null` if none.
 */
function touchesOf(grid: VertexGrid, ax: number, ay: number, bx: number, by: number): number[] | null {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return null
  let found: { p: number; t: number }[] | null = null
  const minY = Math.min(ay, by)
  const maxY = Math.max(ay, by)
  const r0 = cellRow(grid, minY)
  const r1 = cellRow(grid, maxY)
  for (let r = r0; r <= r1; r++) {
    // The cells of row r the edge passes through: its x where it enters and
    // leaves the row's band.
    let c0 = cellColumn(grid, Math.min(ax, bx))
    let c1 = cellColumn(grid, Math.max(ax, bx))
    if (r0 !== r1) {
      const y0 = Math.max(minY, grid.minY + r * grid.cellH)
      const y1 = Math.min(maxY, grid.minY + (r + 1) * grid.cellH)
      const x0 = ax + ((y0 - ay) * dx) / dy
      const x1 = ax + ((y1 - ay) * dx) / dy
      // Widened by a cell for rounding in x0 and x1.
      c0 = Math.max(c0, cellColumn(grid, Math.min(x0, x1)) - 1)
      c1 = Math.min(c1, cellColumn(grid, Math.max(x0, x1)) + 1)
    }
    for (let c = c0; c <= c1; c++) {
      const cell = r * grid.side + c
      for (let p = 2 * grid.starts[cell]; p < 2 * grid.starts[cell + 1]; p += 2) {
        const px = grid.points[p] - ax
        const py = grid.points[p + 1] - ay
        // Collinear, up to the float error of a fractional end (where a clip
        // cut the edge). An integer point off an integer edge is at least
        // 1 / length away, far more than this lets through.
        if (Math.abs(px * dy - py * dx) > 1e-9 * len2) continue
        const t = px * dx + py * dy
        if (t > 0 && t < len2) {
          found ??= []
          found.push({ p, t })
        }
      }
    }
  }
  if (found === null) return null
  found.sort((a, b) => a.t - b.t)
  return found.filter((f, k) => k === 0 || f.t !== found[k - 1].t).map((f) => f.p)
}

function dedupe(coords: Coords): Coords {
  let w = 0
  for (let i = 0; i < coords.length; i += 2) {
    const x = Math.round(coords[i])
    const y = Math.round(coords[i + 1])
    if (w === 0 || coords[w - 2] !== x || coords[w - 1] !== y) {
      coords[w] = x
      coords[w + 1] = y
      w += 2
    }
  }
  coords.length = w
  return coords
}
