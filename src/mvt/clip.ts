/** Clipping to an axis-aligned rectangle, in whatever coordinates. */

import type { Bbox, Coords, Polygon } from './geometry.ts'
import { bbox, reverse, signedArea2 } from './geometry.ts'

const LEFT = 1
const RIGHT = 2
const BOTTOM = 4
const TOP = 8

export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function outcode(x: number, y: number, r: Rect): number {
  let code = 0
  if (x < r.minX) code |= LEFT
  else if (x > r.maxX) code |= RIGHT
  if (y < r.minY) code |= BOTTOM
  else if (y > r.maxY) code |= TOP
  return code
}

/** Points inside the rectangle, edges included. */
export function clipPoints(points: Coords, r: Rect): Coords {
  const out: Coords = []
  for (let i = 0; i < points.length; i += 2) {
    if (outcode(points[i], points[i + 1], r) === 0) out.push(points[i], points[i + 1])
  }
  return out
}

/**
 * Cohen–Sutherland clipping of a polyline, as in `lineclip`. A line that
 * leaves and re-enters becomes several parts.
 */
export function clipLine(line: Coords, r: Rect): Coords[] {
  // A line entirely inside, the common case after a pre-clip, is kept as is.
  let inside = true
  for (let i = 0; i < line.length && inside; i += 2) inside = outcode(line[i], line[i + 1], r) === 0
  if (inside) return line.length >= 4 ? [line] : []
  const parts: Coords[] = []
  let part: Coords = []
  let codeA = outcode(line[0], line[1], r)
  for (let i = 2; i < line.length; i += 2) {
    let ax = line[i - 2]
    let ay = line[i - 1]
    let bx = line[i]
    let by = line[i + 1]
    let codeB = outcode(bx, by, r)
    const lastCode = codeB
    for (;;) {
      if (!(codeA | codeB)) {
        // Both inside: a is already in the part unless the part is new.
        if (part.length === 0) part.push(ax, ay)
        part.push(bx, by)
        if (codeB !== lastCode) {
          // b was clipped: the line leaves here.
          parts.push(part)
          part = []
        }
        break
      }
      if (codeA & codeB) break // both outside on one side
      if (codeA) {
        ;[ax, ay] = intersect(ax, ay, bx, by, codeA, r)
        codeA = outcode(ax, ay, r)
      } else {
        ;[bx, by] = intersect(ax, ay, bx, by, codeB, r)
        codeB = outcode(bx, by, r)
      }
    }
    codeA = lastCode
  }
  if (part.length >= 4) parts.push(part)
  return parts
}

function intersect(ax: number, ay: number, bx: number, by: number, edge: number, r: Rect): [number, number] {
  if (edge & TOP) return [ax + ((bx - ax) * (r.maxY - ay)) / (by - ay), r.maxY]
  if (edge & BOTTOM) return [ax + ((bx - ax) * (r.minY - ay)) / (by - ay), r.minY]
  if (edge & RIGHT) return [r.maxX, ay + ((by - ay) * (r.maxX - ax)) / (bx - ax)]
  return [r.minX, ay + ((by - ay) * (r.minX - ax)) / (bx - ax)]
}

/**
 * The edges of the rectangle a shape with bounding box `box` crosses, in
 * clipping order: `null` when it lies wholly outside, none when inside.
 */
function crossedEdges([minX, minY, maxX, maxY]: Bbox, r: Rect): number[] | null {
  if (maxX < r.minX || minX > r.maxX || maxY < r.minY || minY > r.maxY) return null
  const edges: number[] = []
  if (minX < r.minX) edges.push(LEFT)
  if (maxX > r.maxX) edges.push(RIGHT)
  if (minY < r.minY) edges.push(BOTTOM)
  if (maxY > r.maxY) edges.push(TOP)
  return edges
}

/**
 * Sutherland–Hodgman clipping of an open ring against the rectangle. The
 * result may be empty or have edges along the rectangle's boundary, which
 * MVT accepts. A polygon cut into pieces stays one ring, its pieces joined by
 * zero-width bridges along the boundary, so this is only for coordinates no
 * nonlinear transform follows; before one, use {@link clipPolygon}. The
 * ring's orientation is preserved.
 */
export function clipRing(ring: Coords, r: Rect): Coords {
  if (ring.length < 6) return []
  // Only the edges the ring crosses need a pass: none when it is inside.
  const edges = crossedEdges(bbox(ring), r)
  if (edges === null) return []
  let input = ring
  for (const edge of edges) {
    if (input.length < 6) return []
    const out: Coords = []
    const n = input.length
    let px = input[n - 2]
    let py = input[n - 1]
    let pIn = inside(px, py, edge, r)
    for (let i = 0; i < n; i += 2) {
      const x = input[i]
      const y = input[i + 1]
      const cIn = inside(x, y, edge, r)
      if (cIn !== pIn) {
        const [ix, iy] = intersect(px, py, x, y, edge, r)
        out.push(ix, iy)
      }
      if (cIn) out.push(x, y)
      px = x
      py = y
      pIn = cIn
    }
    input = out
  }
  return input.length < 6 ? [] : input
}

/**
 * Clip a polygon to the rectangle (edges included) into polygons that never
 * run along the rectangle's boundary and back. {@link clipRing} joins the
 * pieces a polygon falls into with such zero-width bridges; they are harmless
 * where they are drawn, but a nonlinear transform afterwards maps the two
 * passes of a bridge through different vertices and the ring crosses itself.
 *
 * Every ring is cut by each edge the polygon crosses, and the pieces left
 * inside are joined along the edge only where the edge runs through the
 * polygon. Exteriors come out with positive area and holes with negative
 * ({@link signedArea2}), each hole with the exterior around it. Rings are
 * shared with the input where nothing changes them. The input must be simple.
 */
export function clipPolygon(polygon: Polygon, r: Rect): Polygon[] {
  const edges = crossedEdges(bbox(polygon.exterior), r)
  if (edges === null) return []
  if (edges.length === 0) return [polygon]
  const exterior = oriented(polygon.exterior, true)
  if (exterior === null) return []
  let rings = [exterior]
  // Holes clear of the edges need no pass: kept when inside, dropped when not.
  const kept: Coords[] = []
  for (const hole of polygon.holes) {
    const box = bbox(hole)
    if (crossedEdges(box, r) === null) continue
    const h = oriented(hole, false)
    if (h === null) continue
    if (box[0] > r.minX && box[2] < r.maxX && box[1] > r.minY && box[3] < r.maxY) kept.push(h)
    else rings.push(h)
  }
  for (const edge of edges) rings = clipRingsToHalfPlane(rings, edge, r)
  return assemble(kept.length ? rings.concat(kept) : rings)
}

/** The ring wound for its role (a reversed copy if it is not); `null` if it has no area. */
function oriented(ring: Coords, exterior: boolean): Coords | null {
  const area = signedArea2(ring)
  if (area === 0) return null
  if (area > 0 === exterior) return ring
  const out = ring.slice()
  reverse(out)
  return out
}

/**
 * An edge of the rectangle as a line: the axis its points share (0 for x, 1
 * for y), their coordinate on it, and the sign that makes the position along
 * it ({@link along}) grow in the direction {@link clipRingsToHalfPlane} links
 * in.
 */
interface EdgeLine {
  axis: 0 | 1
  at: number
  sign: 1 | -1
}

function edgeLine(edge: number, r: Rect): EdgeLine {
  // TOP is the `maxY` edge and BOTTOM the `minY` one, as in `inside`.
  if (edge === LEFT) return { axis: 0, at: r.minX, sign: -1 }
  if (edge === RIGHT) return { axis: 0, at: r.maxX, sign: 1 }
  if (edge === BOTTOM) return { axis: 1, at: r.minY, sign: 1 }
  return { axis: 1, at: r.maxY, sign: -1 }
}

/** Whether point `k` (an index into `pts`) lies on the line. */
function onLine(l: EdgeLine, pts: Coords, k: number): boolean {
  return pts[k + l.axis] === l.at
}

/** The position of point `k` of `pts` along the line. */
function along(l: EdgeLine, pts: Coords, k: number): number {
  return l.sign * pts[k + 1 - l.axis]
}

/**
 * Whether the segment from point `k` to point `j` of `pts` runs along the
 * line against its direction: the polygon lies beyond the edge there, so the
 * ring leaves the half-plane and comes back.
 */
function backward(l: EdgeLine, pts: Coords, k: number, j: number): boolean {
  return onLine(l, pts, k) && onLine(l, pts, j) && along(l, pts, j) < along(l, pts, k)
}

/** Add a run of a ring from an entry to an exit to `chains`, split where it runs backward. */
function addRun(l: EdgeLine, pts: Coords, chains: Coords[]): void {
  let first = 0
  for (let k = 0; k + 2 < pts.length; k += 2) {
    if (backward(l, pts, k, k + 2)) {
      addChain(l, pts.slice(first, k + 2), chains)
      first = k + 2
    }
  }
  addChain(l, first > 0 ? pts.slice(first) : pts, chains)
}

/**
 * Add a chain to `chains` without the points on the line at either end: the
 * link along the line covers them in its own direction. A chain all on the
 * line has no area.
 */
function addChain(l: EdgeLine, pts: Coords, chains: Coords[]): void {
  let s = 0
  while (s + 2 < pts.length && onLine(l, pts, s + 2)) s += 2
  let e = pts.length - 2
  while (e - 2 > s && onLine(l, pts, e - 2)) e -= 2
  if (e > s) chains.push(s > 0 || e < pts.length - 2 ? pts.slice(s, e + 2) : pts)
}

/**
 * Clip correctly wound rings (exteriors positive, holes negative) to the
 * half-plane inside `edge`. A ring whose interior lies on its right (in
 * y-down coordinates, as every ring here does) bounds the clipped region
 * along the edge in one direction only: towards larger y along `maxX`,
 * smaller y along `minX`, smaller x along `maxY` and larger x along `minY`.
 * So along that direction each place a ring leaves the half-plane is
 * followed by the place where one re-enters, and the stretch between them is
 * inside the polygon.
 */
function clipRingsToHalfPlane(rings: Coords[], edge: number, r: Rect): Coords[] {
  const l = edgeLine(edge, r)
  const out: Coords[] = []
  // Runs of rings inside, each from where it enters (on the line) to where it leaves.
  const chains: Coords[] = []
  for (const ring of rings) {
    const len = ring.length
    // An outside vertex to walk from; failing that, whether any is on the line.
    let start = -1
    let touches = false
    for (let k = 0; k < len && start < 0; k += 2) {
      if (!inside(ring[k], ring[k + 1], edge, r)) start = k
      else if (onLine(l, ring, k)) touches = true
    }
    if (start < 0) {
      // Wholly inside, unless it runs backward along the line somewhere: then
      // it is a run from the end of that stretch round to its start.
      let k = 0
      while (touches && k < len && !backward(l, ring, k, (k + 2) % len)) k += 2
      if (!touches || k === len) out.push(ring)
      else addRun(l, ring.slice(k + 2).concat(ring.slice(0, k + 2)), chains)
      continue
    }
    // Walk once round from the outside vertex, cutting at every crossing.
    let run: Coords | null = null
    let px = ring[start]
    let py = ring[start + 1]
    let pIn = false
    for (let s = 2; s <= len; s += 2) {
      const k = (start + s) % len
      const x = ring[k]
      const y = ring[k + 1]
      const cIn = inside(x, y, edge, r)
      if (cIn && !pIn) {
        const [ix, iy] = intersect(px, py, x, y, edge, r)
        run = ix !== x || iy !== y ? [ix, iy, x, y] : [x, y]
      } else if (cIn) {
        run?.push(x, y)
      } else if (pIn && run !== null) {
        const [ix, iy] = intersect(px, py, x, y, edge, r)
        if (run[run.length - 2] !== ix || run[run.length - 1] !== iy) run.push(ix, iy)
        addRun(l, run, chains)
        run = null
      }
      px = x
      py = y
      pIn = cIn
    }
  }

  // Link each exit to the next entry along the line. An exit sorts before an
  // entry at the same place: there the polygon meets the edge at a point (a
  // hole touching its exterior there), with the edge outside it on both sides.
  const ends: { pos: number; chain: number; exit: boolean }[] = []
  chains.forEach((c, i) => {
    ends.push({ pos: along(l, c, 0), chain: i, exit: false }, { pos: along(l, c, c.length - 2), chain: i, exit: true })
  })
  ends.sort((a, b) => a.pos - b.pos || Number(b.exit) - Number(a.exit))
  const next = new Int32Array(chains.length).fill(-1)
  let pending = -1
  for (const e of ends) {
    if (e.exit) pending = e.chain
    else if (pending >= 0) {
      next[pending] = e.chain
      pending = -1
    }
  }

  // Follow the links into rings. Each chain is used once, so this ends even
  // for input that is not simple; an unlinked exit closes its ring directly.
  const used = new Uint8Array(chains.length)
  for (let i = 0; i < chains.length; i++) {
    if (used[i]) continue
    const ring: Coords = []
    for (let c = i; c >= 0 && !used[c]; c = next[c]) {
      used[c] = 1
      const pts = chains[c]
      for (let j = 0; j < pts.length; j += 2) {
        if (ring.length && ring[ring.length - 2] === pts[j] && ring[ring.length - 1] === pts[j + 1]) continue
        ring.push(pts[j], pts[j + 1])
      }
    }
    const n = ring.length
    if (n >= 4 && ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) ring.length -= 2
    if (ring.length >= 6 && signedArea2(ring) !== 0) out.push(ring)
  }
  return out
}

/** Clipped rings as polygons: each hole goes with the exterior around it. */
function assemble(rings: Coords[]): Polygon[] {
  const polygons: Polygon[] = []
  const holes: Coords[] = []
  for (const ring of rings) {
    if (signedArea2(ring) > 0) polygons.push({ exterior: ring, holes: [] })
    else holes.push(ring)
  }
  if (polygons.length === 1) {
    polygons[0].holes = holes
    return polygons
  }
  const boxes = polygons.map((p) => bbox(p.exterior))
  for (const hole of holes) {
    // Exteriors do not overlap, so at most one contains the hole.
    const [hx0, hy0, hx1, hy1] = bbox(hole)
    const owner = polygons.findIndex((p, k) => {
      const b = boxes[k]
      return hx0 >= b[0] && hx1 <= b[2] && hy0 >= b[1] && hy1 <= b[3] && ringContains(p.exterior, hole)
    })
    if (owner >= 0) polygons[owner].holes.push(hole)
  }
  return polygons
}

/** Whether `ring` contains `other`, judged by the first of its vertices not on `ring`'s boundary. */
function ringContains(ring: Coords, other: Coords): boolean {
  for (let i = 0; i < other.length; i += 2) {
    const result = pointInRing(other[i], other[i + 1], ring)
    if (result !== 0) return result > 0
  }
  return true
}

/** 1 inside, -1 outside, 0 on the boundary (even-odd). */
function pointInRing(x: number, y: number, ring: Coords): number {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i]
    const yi = ring[i + 1]
    const xj = ring[j]
    const yj = ring[j + 1]
    const onSegment =
      (xj - xi) * (y - yi) === (yj - yi) * (x - xi) &&
      Math.min(xi, xj) <= x &&
      x <= Math.max(xi, xj) &&
      Math.min(yi, yj) <= y &&
      y <= Math.max(yi, yj)
    if (onSegment) return 0
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside ? 1 : -1
}

function inside(x: number, y: number, edge: number, r: Rect): boolean {
  switch (edge) {
    case LEFT:
      return x >= r.minX
    case RIGHT:
      return x <= r.maxX
    case BOTTOM:
      return y >= r.minY
    default:
      return y <= r.maxY
  }
}
