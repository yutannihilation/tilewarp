/**
 * Joining the pieces of one polygon that source tile boundaries cut it into.
 * Pre-clipping gives each source tile its own piece, with an edge along the
 * boundary where the polygon continues into the neighbour; a fill layer with
 * an outline color draws those edges. Here they are dropped and the pieces
 * joined across the boundary, in the tiles' common coordinates, before the
 * transform.
 */

import { assemble } from './clip.ts'
import type { Coords, Polygon } from './geometry.ts'
import { signedArea2 } from './geometry.ts'

/** What one source tile holds of a polygon feature. */
export interface Piece {
  /**
   * The source tile's column and row in the common frame: the tile spans
   * `[column * extent, (column + 1) * extent]` in x, and so in y by `row`.
   */
  column: number
  row: number
  /** In the common frame, clipped to the tile, as {@link clipPolygon} leaves them. */
  polygons: Polygon[]
}

/** What is left of a ring between two cuts, with the tile it is from. */
interface Chain {
  coords: Coords
  column: number
  row: number
}

/**
 * The pieces as polygons without the cuts, or `null` when they do not fit
 * together, and the pieces should be kept as they are.
 *
 * An edge on the boundary between two tiles that were both read is a cut and
 * is dropped, which leaves chains that start and end on a boundary. The end
 * of each chain is joined to the start of the one chain from another tile
 * that begins within `tolerance` of it: the two tiles cut the same edge of
 * the source polygon, but each from its own rounded copy, so the points
 * differ by a unit or so. The end's point is kept and the start's dropped.
 *
 * The pieces do not fit when an end has no such start, or several (the
 * neighbour has the feature under another id, or not at all; an edge of the
 * polygon itself runs along the boundary; a part is thinner than the
 * tolerance). The result's area is also compared with the pieces', which
 * catches only a gross mismatch: the area hardly depends on which end joins
 * which start. A join moves a point by up to the tolerance, so where a part
 * of the polygon is no wider than that at a boundary (or an edge of its own
 * lies on the boundary and is that short), its shape can change by as much.
 *
 * @param read - whether the tile at a column and row was read; an edge on
 *   the boundary to a tile that was not is kept
 * @param tolerance - how far apart the two tiles' copies of a crossing may be
 */
export function mergePieces(
  pieces: Piece[],
  extent: number,
  read: (column: number, row: number) => boolean,
  tolerance: number,
): Polygon[] | null {
  const rings: Coords[] = []
  const chains: Chain[] = []
  let area = 0
  for (const piece of pieces) {
    for (const polygon of piece.polygons) {
      for (const ring of [polygon.exterior, ...polygon.holes]) {
        area += signedArea2(ring)
        split(ring, piece, extent, read, rings, chains)
      }
    }
  }
  // Nothing was cut: the pieces only share an id.
  if (chains.length === 0) return null

  const next = pair(chains, tolerance)
  if (next === null) return null

  // What a join may change the area by: it moves the start of a chain's
  // first edge by at most the tolerance each way.
  let slack = 0
  const joined = new Uint8Array(chains.length)
  for (let first = 0; first < chains.length; first++) {
    if (joined[first]) continue
    const ring: Coords = []
    let k = first
    do {
      joined[k] = 1
      const { coords } = chains[k]
      slack += 2 * tolerance * (Math.abs(coords[2] - coords[0]) + Math.abs(coords[3] - coords[1]))
      // Without its start: the end of the chain before stands for it.
      for (let i = 2; i < coords.length; i++) ring.push(coords[i])
      k = next[k]
    } while (k !== first)
    const clean = withoutRepeats(ring)
    if (clean.length >= 6 && signedArea2(clean) !== 0) rings.push(clean)
  }
  let mergedArea = 0
  for (const ring of rings) mergedArea += signedArea2(ring)
  if (Math.abs(mergedArea - area) > slack + 1e-6 * Math.abs(area)) return null

  const polygons = assemble(rings)
  return polygons.length ? polygons : null
}

/**
 * A ring of a piece without its cuts: whole into `rings` when it has none,
 * or else the chains between them into `chains`.
 */
function split(
  ring: Coords,
  piece: Piece,
  extent: number,
  read: (column: number, row: number) => boolean,
  rings: Coords[],
  chains: Chain[],
): void {
  const n = ring.length / 2
  const cut = new Uint8Array(n)
  let cuts = 0
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1
    if (isCut(ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1], piece, extent, read)) {
      cut[i] = 1
      cuts++
    }
  }
  if (cuts === 0) {
    rings.push(ring)
    return
  }
  // Nothing but cuts: the outline of a tile the polygon covers whole.
  if (cuts === n) return
  // From an edge that follows a cut, once around.
  let start = 0
  while (!(cut[start === 0 ? n - 1 : start - 1] && !cut[start])) start++
  let coords: Coords | undefined
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (cut[i]) {
      coords = undefined
      continue
    }
    if (coords === undefined) {
      coords = [ring[2 * i], ring[2 * i + 1]]
      chains.push({ coords, column: piece.column, row: piece.row })
    }
    const j = i + 1 === n ? 0 : i + 1
    coords.push(ring[2 * j], ring[2 * j + 1])
  }
}

/** Whether the edge lies on the piece's tile's boundary to a tile that was read. */
function isCut(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  { column, row }: Piece,
  extent: number,
  read: (column: number, row: number) => boolean,
): boolean {
  if (ax === bx) {
    if (ax === column * extent) return read(column - 1, row)
    if (ax === (column + 1) * extent) return read(column + 1, row)
  }
  if (ay === by) {
    if (ay === row * extent) return read(column, row - 1)
    if (ay === (row + 1) * extent) return read(column, row + 1)
  }
  return false
}

/**
 * For each chain, the chain its end joins: the only one from another tile
 * that starts within the tolerance, and that no other chain joins. `null`
 * when a chain has none or several.
 */
function pair(chains: Chain[], tolerance: number): Int32Array | null {
  // Starts by grid cell of the tolerance's size: a match is in the 3 × 3 around.
  const cells = new Map<string, number[]>()
  const cell = (v: number) => Math.floor(v / tolerance)
  for (let k = 0; k < chains.length; k++) {
    const { coords } = chains[k]
    const key = `${cell(coords[0])},${cell(coords[1])}`
    const list = cells.get(key)
    if (list === undefined) cells.set(key, [k])
    else list.push(k)
  }
  const next = new Int32Array(chains.length).fill(-1)
  const taken = new Uint8Array(chains.length)
  for (let k = 0; k < chains.length; k++) {
    const { coords, column, row } = chains[k]
    const ex = coords[coords.length - 2]
    const ey = coords[coords.length - 1]
    const cx = cell(ex)
    const cy = cell(ey)
    let found = -1
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const s of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const other = chains[s]
          if (other.column === column && other.row === row) continue
          if (Math.abs(other.coords[0] - ex) > tolerance || Math.abs(other.coords[1] - ey) > tolerance) continue
          if (found >= 0) return null
          found = s
        }
      }
    }
    if (found < 0 || taken[found]) return null
    taken[found] = 1
    next[k] = found
  }
  return next
}

/** The ring without points that repeat the one before (the last before the first, too). */
function withoutRepeats(ring: Coords): Coords {
  const out: Coords = []
  for (let i = 0; i < ring.length; i += 2) {
    const n = out.length
    if (n >= 2 && out[n - 2] === ring[i] && out[n - 1] === ring[i + 1]) continue
    out.push(ring[i], ring[i + 1])
  }
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2
  return out
}
