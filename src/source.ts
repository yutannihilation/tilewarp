/** What the warp reads: a Web Mercator XYZ tile source. */

import type { RgbaImage } from './png.ts'

/** What the warp needs to know about the Web Mercator XYZ source. */
export interface TileSource {
  minzoom: number
  maxzoom: number
  /** Width and height of every source tile in pixels. */
  tileSize: number
  /**
   * Vector only. Join the pieces of a polygon that source tile boundaries
   * cut, where the pieces have the same feature id, so that a fill's outline
   * is not drawn along the boundaries. Default false.
   */
  merge?: boolean
}

/**
 * A Web Mercator XYZ source the warp reads tiles from: over HTTPS
 * ({@link XyzSource}), or anything else that can answer by tile index.
 */
export interface MercatorSource extends TileSource {
  /** Names the source in caches: tiles of sources with the same id are shared. */
  readonly id: string
  /**
   * The tile's bytes, decompressed (MVT, or an encoded image); `null` where
   * the source has no tile.
   */
  tile(z: number, x: number, y: number): Promise<Uint8Array | null>
}

/** Decodes a raster source tile (PNG, JPEG, WebP, …) to RGBA; supplied by the runtime. */
export type RasterDecoder = (bytes: Uint8Array) => Promise<RgbaImage>
