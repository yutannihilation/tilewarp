/**
 * Output tiles from a Web Mercator tile source, with the source tiles kept
 * in memory across calls: decoded raster tiles and prepared vector
 * tiles, each bounded by bytes, and reads in flight shared by concurrent
 * calls. One instance serves a whole process (an isolate, a worker).
 */

import type { Crs } from './crs.ts'
import { SourceError } from './errors.ts'
import { LruCache } from './lru.ts'
import { memoized } from './memo.ts'
import { WORLD } from './mercator.ts'
import type { RgbaImage } from './png.ts'
import type { MercatorSource, RasterDecoder, TileSource } from './source.ts'
import type { RasterTiming, VectorTiming } from './timing.ts'
import { tileAffine } from './tms.ts'
import type { SourceTile } from './vector.ts'
import { prepareSourceTile, renderVectorTile, tileZeroMeters } from './vector.ts'
import { chooseSourceZoom, mercatorField, sampleField, tileFromKey } from './warp.ts'

/** Width and height of a raster output tile in pixels. */
export const TILE_SIZE = 256

/** What a missing vector tile counts for in the vector tile cache. */
const EMPTY_TILE_BYTES = 64

export interface WarperOptions {
  decode: RasterDecoder
  /**
   * Decoded RGBA bytes of the source tiles one raster output tile may read
   * (the source zoom is lowered to fit), in bytes since the source's tile
   * size is only known at runtime.
   */
  maxSourceBytes: number
  /** Decoded raster source tiles kept, by their RGBA size. */
  rasterCacheBytes: number
  /** Prepared vector source tiles kept, by their rough heap size. */
  vectorCacheBytes: number
}

export class Warper {
  readonly #decode: RasterDecoder
  readonly #maxSourceBytes: number
  /** Decoded raster source tiles, pending reads included. */
  readonly #rasterTiles: LruCache<string, Promise<RgbaImage | null>>
  /** Prepared vector source tiles, weighted by their size, which is known once prepared. */
  readonly #vectorTiles: LruCache<string, SourceTile | null>
  /** Vector reads in flight, shared by concurrent calls until they settle. */
  readonly #vectorReads = new Map<string, Promise<SourceTile | null>>()

  constructor(options: WarperOptions) {
    this.#decode = options.decode
    this.#maxSourceBytes = options.maxSourceBytes
    this.#rasterTiles = new LruCache(options.rasterCacheBytes)
    this.#vectorTiles = new LruCache(options.vectorCacheBytes)
  }

  /**
   * @param signal - once aborted, the tile is not sampled: checked when the
   *   source tiles are in, since sampling runs to the end once started. Source
   *   reads under way still finish and are cached, as other tiles share them.
   * @returns `null` when no pixel of the tile is in Web Mercator, or when the
   *   tile is too coarse for the source (it would read too many tiles even at
   *   the source's `minzoom`). For a `nearest` source, also when the source
   *   has none of the tiles under it; where it has some, the pixels over a
   *   missing one stay transparent. Its pixels past Web Mercator's latitude
   *   limit take the value of the limit at their longitude.
   */
  async renderRasterTile(
    crs: Crs,
    source: MercatorSource,
    z: number,
    x: number,
    y: number,
    timing: RasterTiming,
    signal?: AbortSignal,
  ): Promise<RgbaImage | null> {
    let t = performance.now()
    const affine = tileAffine(crs.tms, z, x, y, TILE_SIZE)
    const nearest = source.resampling === 'nearest'
    const field = mercatorField(affine, TILE_SIZE, crs.to3857, crs.from3857, nearest)
    let t1 = performance.now()
    timing.field = t1 - t
    t = t1
    const maxTiles = Math.max(1, Math.floor(this.#maxSourceBytes / rgbaBytes(source.tileSize)))
    const choice = chooseSourceZoom(field, TILE_SIZE, source, maxTiles)
    t1 = performance.now()
    timing.zoom = t1 - t
    t = t1
    if (choice === null) return null
    timing.sourceZoom = choice.z
    timing.tiles = choice.keys.size
    const tiles = new Map(
      await Promise.all(
        [...choice.keys].map(async (key) => {
          const [tx, ty] = tileFromKey(choice.z, key)
          return [key, await this.#rasterSourceTile(source, choice.z, tx, ty, timing)] as const
        }),
      ),
    )
    signal?.throwIfAborted()
    t1 = performance.now()
    timing.fetch = t1 - t
    t = t1
    // Transparent black would be a DEM's lowest elevation all over the tile.
    if (nearest && [...tiles.values()].every((tile) => tile === null)) return null
    const out = sampleField(field, TILE_SIZE, choice.z, source.tileSize, tiles, source.resampling)
    timing.sample = performance.now() - t
    return out
  }

  /**
   * MVT bytes of output tile `z/x/y`, empty when nothing of the source falls in
   * it or the tile is too coarse for the source (it would read too many tiles
   * even at the source's `minzoom`).
   *
   * @param signal - once aborted, the tile is not transformed: checked as each
   *   source tile comes in, which is the last point before the transform, as
   *   it then runs to the end without yielding. Source reads under way still
   *   finish and are cached, as other tiles share them.
   */
  renderVectorTile(
    crs: Crs,
    source: MercatorSource,
    z: number,
    x: number,
    y: number,
    timing: VectorTiming,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return renderVectorTile(
      crs,
      source,
      z,
      x,
      y,
      async (sz, sx, sy) => {
        const tile = await this.#vectorSourceTile(source, sz, sx, sy, timing)
        signal?.throwIfAborted()
        return tile
      },
      timing,
    )
  }

  /**
   * A decoded source tile, from the cache when it has it. Pending reads are
   * shared too, since neighboring output tiles need the same ones. The
   * source's id is part of the key, so sources do not share tiles unless
   * their ids say they are the same.
   */
  #rasterSourceTile(
    source: MercatorSource,
    z: number,
    x: number,
    y: number,
    timing: RasterTiming,
  ): Promise<RgbaImage | null> {
    const key = `${source.id}/${z}/${x}/${y}`
    if (this.#rasterTiles.get(key) === undefined) timing.misses++
    return memoized(
      this.#rasterTiles,
      key,
      () => this.#readRasterSourceTile(source, z, x, y),
      rgbaBytes(source.tileSize),
    )
  }

  async #readRasterSourceTile(source: MercatorSource, z: number, x: number, y: number): Promise<RgbaImage | null> {
    const bytes = await source.tile(z, x, y)
    const image = bytes && (await this.#decode(bytes))
    if (image && (image.width !== source.tileSize || image.height !== source.tileSize)) {
      throw new SourceError(`Tile ${z}/${x}/${y} is ${image.width}x${image.height}, expected ${source.tileSize}px`)
    }
    return image
  }

  /**
   * A decoded and pre-clipped vector source tile (`null` where the source has
   * none), from the cache when it has it; pending reads are shared, failures
   * are not kept.
   */
  #vectorSourceTile(
    source: MercatorSource,
    z: number,
    x: number,
    y: number,
    timing: VectorTiming,
  ): Promise<SourceTile | null> {
    const key = `${source.id}/${z}/${x}/${y}`
    const cached = this.#vectorTiles.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    timing.misses++
    let read = this.#vectorReads.get(key)
    if (read === undefined) {
      read = source
        .tile(z, x, y)
        .then((bytes) => {
          const tile = bytes === null ? null : prepareSourceTile(bytes)
          this.#vectorTiles.set(key, tile, tile?.bytes ?? EMPTY_TILE_BYTES)
          return tile
        })
        .finally(() => this.#vectorReads.delete(key))
      this.#vectorReads.set(key, read)
    }
    return read
  }
}

/**
 * The output zoom beyond which a client should overzoom a raster source
 * instead of asking: the one whose pixels are nearest in size to the source's
 * at its `maxzoom`, which is the last zoom the zoom choice does not clamp
 * to `maxzoom`. Beyond it a `nearest` source would repeat its pixels. By
 * {@link tileZeroMeters}; `maxZoom` if nowhere has a Mercator position.
 */
export function rasterMaxZoom(crs: Crs, source: Pick<TileSource, 'maxzoom' | 'tileSize'>, maxZoom: number): number {
  const pixel0Meters = tileZeroMeters(crs) / TILE_SIZE
  if (Number.isNaN(pixel0Meters)) return maxZoom
  const sourcePixelMeters = WORLD / (2 ** source.maxzoom * source.tileSize)
  const z = Math.round(Math.log2(pixel0Meters / sourcePixelMeters))
  return Math.min(maxZoom, Math.max(0, z))
}

function rgbaBytes(tileSize: number): number {
  return tileSize * tileSize * 4
}
