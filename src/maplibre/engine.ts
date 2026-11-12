/**
 * What the protocol asks of the warp: register a CRS, answer a TileJSON,
 * render a tile. Runs in the plugin's Web Worker, or on the main thread when
 * the protocol is created with `worker: false`; the caches live as long as
 * the engine.
 */

import type { Crs, EpsgProjJson } from '../crs.ts'
import { buildCrs } from '../crs.ts'
import { browserDecoder } from '../decode.ts'
import { SourceError } from '../errors.ts'
import { memoized } from '../memo.ts'
import type { Resampling } from '../source.ts'
import { createRasterTiming, createVectorTiming } from '../timing.ts'
import { vectorMaxZoom } from '../vector.ts'
import { rasterMaxZoom, TILE_SIZE, Warper } from '../warper.ts'
import type { XyzSource } from '../xyz.ts'
import { xyzSourceFromTileJson } from '../xyz.ts'
import type { Call } from './rpc.ts'

/** The deepest output zoom served, as on the server. */
export const MAX_ZOOM = 24

/**
 * Memory budgets, as the server's per isolate: decoded RGBA of the source
 * tiles one raster tile may read (8 MB is 32 tiles at 256px) and of those
 * kept (16 MB is 64), and prepared vector source tiles kept.
 */
const MAX_SOURCE_BYTES = 8 * 2 ** 20
const RASTER_CACHE_BYTES = 16 * 2 ** 20
const VECTOR_CACHE_BYTES = 32 * 2 ** 20

export type TileFormat = 'mvt' | 'png'

export interface TileRequest {
  epsg: number
  /** Absolute URL of the Web Mercator source's TileJSON. */
  source: string
  z: number
  x: number
  y: number
  format: TileFormat
  /** Set by the source URL's `nearest` segment; otherwise the source's own default. */
  resampling?: Resampling
}

/**
 * MVT bytes for `mvt`, the drawn tile for `png` (no bytes where a source
 * sampled by nearest neighbor has no tile, which MapLibre takes as no tile);
 * both transferable.
 */
export type TileResult = ArrayBuffer | ImageBitmap

export class WarpEngine {
  readonly #crs = new Map<number, Crs>()
  /** Sources by TileJSON URL and the resampling asked for; a failed TileJSON is not kept. */
  readonly #sources = new Map<string, Promise<XyzSource>>()
  readonly #warper = new Warper({
    decode: browserDecoder,
    maxSourceBytes: MAX_SOURCE_BYTES,
    rasterCacheBytes: RASTER_CACHE_BYTES,
    vectorCacheBytes: VECTOR_CACHE_BYTES,
  })

  /** @throws {CrsError} If the CRS cannot be tiled. */
  addCrs(epsg: number, projjson: EpsgProjJson): void {
    this.#crs.set(epsg, buildCrs(epsg, projjson))
  }

  /**
   * The reprojected TileJSON of the source at `sourceUrl`, whose tiles are
   * `{url}/{z}/{x}/{y}.mvt` for a vector source (one with `vector_layers`)
   * or `.png` for a raster one, with the source's attribution and, for
   * vector, its layers and the zoom beyond which the map should overzoom;
   * for a raster-dem source that states it, its `encoding`. A raster source
   * sampled by nearest neighbor also gets the zoom to overzoom beyond, as
   * its pixels would be repeated past it.
   */
  async tileJson(epsg: number, sourceUrl: string, url: string, resampling?: Resampling): Promise<object> {
    const crs = this.#crsOf(epsg)
    const source = await this.#source(sourceUrl, resampling)
    const common = { tilejson: '3.0.0', minzoom: 0, attribution: source.attribution }
    if (source.vectorLayers !== undefined) {
      return {
        ...common,
        tiles: [`${url}/{z}/{x}/{y}.mvt`],
        vector_layers: source.vectorLayers,
        maxzoom: vectorMaxZoom(crs, source.maxzoom, MAX_ZOOM),
      }
    }
    return {
      ...common,
      tiles: [`${url}/{z}/{x}/{y}.png`],
      tileSize: TILE_SIZE,
      maxzoom: source.resampling === 'nearest' ? rasterMaxZoom(crs, source, MAX_ZOOM) : MAX_ZOOM,
      // MapLibre takes the key's presence as the encoding, even when undefined.
      ...(source.encoding !== undefined && { encoding: source.encoding }),
    }
  }

  /**
   * @param signal - once aborted before the source tiles are all in, the tile
   *   is not rendered; a render under way runs to the end. Source reads under
   *   way finish and stay cached, as other tiles share them.
   */
  async tile(
    { epsg, source: sourceUrl, z, x, y, format, resampling }: TileRequest,
    signal?: AbortSignal,
  ): Promise<TileResult> {
    if (z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) throw new RangeError(`Tile ${z}/${x}/${y} is out of range`)
    const crs = this.#crsOf(epsg)
    const source = await this.#source(sourceUrl, resampling)
    signal?.throwIfAborted()
    if (format === 'mvt') {
      if (source.vectorLayers === undefined) throw new SourceError(`${sourceUrl} is not a vector source`)
      const mvt = await this.#warper.renderVectorTile(crs, source, z, x, y, createVectorTiming(), signal)
      // The encoder's bytes are a view into a larger buffer; transfer only them.
      return mvt.slice().buffer
    }
    if (source.vectorLayers !== undefined) throw new SourceError(`${sourceUrl} is a vector source, not raster`)
    const image = await this.#warper.renderRasterTile(crs, source, z, x, y, createRasterTiming(), signal)
    // Transparent pixels would be elevations to a raster-dem source.
    if (image === null && source.resampling === 'nearest') return new ArrayBuffer(0)
    // The sampler allocates its output, never in a SharedArrayBuffer.
    const data = image
      ? new Uint8ClampedArray(image.data.buffer as ArrayBuffer, image.data.byteOffset, image.data.byteLength)
      : new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
    return createImageBitmap(new ImageData(data, TILE_SIZE, TILE_SIZE))
  }

  #crsOf(epsg: number): Crs {
    const crs = this.#crs.get(epsg)
    if (crs === undefined) throw new Error(`EPSG:${epsg} has not been added with addCrs`)
    return crs
  }

  #source(url: string, resampling?: Resampling): Promise<XyzSource> {
    return memoized(this.#sources, `${resampling ?? ''} ${url}`, () => xyzSourceFromTileJson(url, { resampling }))
  }
}

/** Runs a call from the protocol, in the worker or inline. */
export function runCall(engine: WarpEngine, call: Call, signal?: AbortSignal): Promise<unknown> | undefined {
  switch (call.method) {
    case 'addCrs':
      engine.addCrs(call.epsg, call.projjson)
      return undefined
    case 'tileJson':
      return engine.tileJson(call.epsg, call.source, call.url, call.resampling)
    case 'tile':
      return engine.tile(call.request, signal)
  }
}
