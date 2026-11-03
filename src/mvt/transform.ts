/**
 * Reprojecting flat coordinates point by point, with adaptive densification
 * so that straight source segments follow their curve in the target.
 */

import type { Coords } from './geometry.ts'

/** A point transform; `NaN` components where the point has no image. */
export type PointTransform = (x: number, y: number) => [number, number]

export interface DensifyOptions {
  /** Largest allowed distance, in target units, between a segment and the curve. */
  tolerance: number
  /** Recursion limit per segment (2^depth pieces at most); 0 keeps segments as they are. */
  maxDepth: number
  /** A jump longer than this at the recursion limit is a projection seam. */
  maxSegment: number
  /**
   * A segment whose image is no longer than this is kept as it is: the
   * transform cannot bend it by more than the tolerance.
   */
  minChord: number
}

function finite(p: [number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1])
}

/**
 * Transform a polyline. It is split where a point or a segment's midpoint
 * has no image, or where a segment crosses a seam (see
 * {@link DensifyOptions.maxSegment}); parts with one point are dropped.
 */
export function transformLine(line: Coords, f: PointTransform, options: DensifyOptions): Coords[] {
  const parts: Coords[] = []
  let part: Coords = []
  const flush = () => {
    if (part.length >= 4) parts.push(part)
    part = []
  }
  let ax = line[0]
  let ay = line[1]
  let fa = f(ax, ay)
  if (finite(fa)) part.push(fa[0], fa[1])
  for (let i = 2; i < line.length; i += 2) {
    const bx = line[i]
    const by = line[i + 1]
    const fb = f(bx, by)
    if (finite(fa) && finite(fb)) {
      if (options.maxDepth > 0) {
        const before = part.length
        densify(ax, ay, bx, by, fa, fb, f, options, 0, part)
        // A split marker among the added points ends the part there.
        for (let k = before; k < part.length; k += 2) {
          if (Number.isNaN(part[k])) {
            const rest = part.slice(k + 2)
            part.length = k
            flush()
            part = rest
            k = -2
          }
        }
      }
      part.push(fb[0], fb[1])
    } else {
      flush()
      if (finite(fb)) part.push(fb[0], fb[1])
    }
    ax = bx
    ay = by
    fa = fb
  }
  flush()
  return parts
}

/**
 * Transform an open ring. `null` if any vertex or segment midpoint has no
 * image, or any segment still jumps farther than `maxSegment` at the
 * densification limit (the ring crosses a seam).
 */
export function transformRing(ring: Coords, f: PointTransform, options: DensifyOptions): Coords | null {
  const n = ring.length / 2
  const out: Coords = []
  if (options.maxDepth === 0) {
    for (let i = 0; i < n; i++) {
      const p = f(ring[2 * i], ring[2 * i + 1])
      if (!finite(p)) return null
      out.push(p[0], p[1])
    }
    return out
  }
  const images: [number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const p = f(ring[2 * i], ring[2 * i + 1])
    if (!finite(p)) return null
    images[i] = p
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    out.push(images[i][0], images[i][1])
    const before = out.length
    densify(ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1], images[i], images[j], f, options, 0, out)
    for (let k = before; k < out.length; k += 2) if (Number.isNaN(out[k])) return null
  }
  return out
}

/**
 * Push the intermediate points of segment a→b (exclusive) into `out`, where
 * the transformed midpoint strays from the chord by more than the tolerance.
 * A `NaN, NaN` pair in `out` marks a place to split: the callers scan for it.
 */
function densify(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  fa: [number, number],
  fb: [number, number],
  f: PointTransform,
  options: DensifyOptions,
  depth: number,
  out: Coords,
): void {
  if (Math.hypot(fb[0] - fa[0], fb[1] - fa[1]) <= options.minChord) return
  if (depth >= options.maxDepth) {
    // A tiny source piece whose image still jumps across the tile matrix set
    // crosses a projection seam: mark it for the caller to split or drop.
    if (Math.abs(fb[0] - fa[0]) > options.maxSegment || Math.abs(fb[1] - fa[1]) > options.maxSegment) {
      out.push(Number.NaN, Number.NaN)
    }
    return
  }
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const fm = f(mx, my)
  if (!finite(fm)) {
    // The segment leaves the domain between its ends: split or drop it.
    out.push(Number.NaN, Number.NaN)
    return
  }
  const dx = fm[0] - (fa[0] + fb[0]) / 2
  const dy = fm[1] - (fa[1] + fb[1]) / 2
  if (dx * dx + dy * dy <= options.tolerance * options.tolerance) return
  densify(ax, ay, mx, my, fa, fm, f, options, depth + 1, out)
  out.push(fm[0], fm[1])
  densify(mx, my, bx, by, fm, fb, f, options, depth + 1, out)
}
