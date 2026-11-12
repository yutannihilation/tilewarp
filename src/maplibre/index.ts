/**
 * A MapLibre GL JS protocol that reprojects Web Mercator XYZ tile sources into
 * a custom CRS in the browser.
 *
 * ```ts
 * const protocol = new WarpProtocol()
 * maplibregl.addProtocol(SCHEME, protocol.tile)
 * maplibregl.addProjection(await protocol.addCrs(6677))
 * // style: projection: { type: 'EPSG:6677' }, sources: {
 * //   osm: { type: 'vector', url: 'tilewarp://6677/https://tiles.openfreemap.org/planet' },
 * // }
 * ```
 *
 * A source URL `tilewarp://{epsg}/{TileJSON URL}` names the Web Mercator
 * source by its TileJSON and answers with the reprojected TileJSON, whose
 * tiles are `{source URL}/{z}/{x}/{y}.mvt` (a vector source, one with
 * `vector_layers`) or `.png` (a raster source). The TileJSON URL may be
 * relative to the page.
 *
 * `tilewarp://{epsg}/nearest/{TileJSON URL}` samples a raster source by
 * nearest neighbor instead of bilinearly, as a `raster-dem` source needs. A
 * source whose TileJSON has `encoding` is sampled so without the segment.
 */

import { parseWkt } from '@developmentseed/proj'
import type { AddProtocolAction, CRS } from 'maplibre-gl'
import proj4 from 'proj4'
import type { EpsgProjJson } from '../crs.ts'
import { buildCrs, fetchEpsgProjJson } from '../crs.ts'
import type { Resampling } from '../source.ts'
import type { TileFormat } from './engine.ts'
import { runCall, WarpEngine } from './engine.ts'
import type { Call, Request, Response } from './rpc.ts'

/** The URL scheme to register the protocol under, as in the URLs it reads. */
export const SCHEME = 'tilewarp'

// The optional `nearest/` before the TileJSON URL asks for nearest-neighbor sampling.
const TILEJSON_URL = /^tilewarp:\/\/(\d+)\/(nearest\/)?(.+)$/
const TILE_URL = /^tilewarp:\/\/(\d+)\/(nearest\/)?(.+)\/(\d+)\/(\d+)\/(\d+)\.(mvt|png)$/

export interface WarpProtocolOptions {
  /**
   * Render in a Web Worker the protocol creates (the default), or on the main
   * thread, which blocks rendering while a tile is warped. The worker is
   * loaded with `new Worker(new URL('./worker.js', import.meta.url))`, which
   * Vite, webpack 5 and Parcel bundle; Vite needs the package excluded from
   * `optimizeDeps`.
   */
  worker?: boolean
}

/** Something that runs calls: the worker, or an engine on this thread. */
interface Backend {
  call(call: Call, signal?: AbortSignal): Promise<unknown>
  terminate(): void
}

export class WarpProtocol {
  readonly #backend: Backend
  readonly #added = new Set<number>()

  constructor(options: WarpProtocolOptions = {}) {
    this.#backend = options.worker === false ? inlineBackend() : workerBackend()
  }

  /**
   * Prepare a CRS for tiles and return what `maplibregl.addProjection` takes.
   * Await it before the map loads a source in this CRS: a source read before
   * fails, and MapLibre does not ask again. The PROJJSON comes from epsg.io
   * unless given; it needs epsg.io's `bbox` (the area of use), from which the
   * tile matrix set is derived.
   *
   * @throws {CrsError} If epsg.io does not know the code or the CRS cannot be tiled.
   * @throws {UpstreamError} If epsg.io fails.
   */
  addCrs = async (epsg: number, projjson?: EpsgProjJson): Promise<CRS> => {
    const json = projjson ?? (await fetchEpsgProjJson(epsg, (url) => fetch(url)))
    const crs = buildCrs(epsg, json)
    await this.#backend.call({ method: 'addCrs', epsg, projjson: json })
    this.#added.add(epsg)
    // proj4's typings don't cover wkt-parser output, which it accepts at runtime.
    // @ts-expect-error - incomplete proj4 typings
    const projection = proj4('EPSG:4326', parseWkt(json)) as CRS['projection']
    return {
      name: `EPSG:${epsg}`,
      projection,
      tileMatrixSet: { origin: crs.tms.origin, extentAtZoom0: crs.tms.extentAtZoom0 },
    }
  }

  /** The handler to pass to `maplibregl.addProtocol(SCHEME, …)`. */
  tile: AddProtocolAction = async (params, abortController) => {
    const signal = abortController.signal
    if (params.type === 'json') {
      const match = TILEJSON_URL.exec(params.url)
      if (match === null) throw new Error(`Not a ${SCHEME} source URL: ${params.url}`)
      const epsg = this.#checkAdded(match[1])
      const source = resolveUrl(match[3])
      const resampling = resamplingOf(match[2])
      const data = await this.#backend.call({ method: 'tileJson', epsg, source, url: params.url, resampling }, signal)
      return { data: data as object }
    }
    const match = TILE_URL.exec(params.url)
    if (match === null) throw new Error(`Not a ${SCHEME} tile URL ({z}/{x}/{y}.mvt or .png): ${params.url}`)
    const request = {
      epsg: this.#checkAdded(match[1]),
      resampling: resamplingOf(match[2]),
      source: resolveUrl(match[3]),
      z: Number(match[4]),
      x: Number(match[5]),
      y: Number(match[6]),
      format: match[7] as TileFormat,
    }
    const data = await this.#backend.call({ method: 'tile', request }, signal)
    return { data: data as ArrayBuffer | ImageBitmap }
  }

  /** Stop the worker and fail the calls under way; the protocol cannot be used afterwards. */
  terminate(): void {
    this.#backend.terminate()
  }

  #checkAdded(code: string): number {
    const epsg = Number(code)
    if (!this.#added.has(epsg)) throw new Error(`EPSG:${epsg} has not been added with addCrs`)
    return epsg
  }
}

/** What the source URL's optional segment asks for; without it, the source's default. */
function resamplingOf(segment: string | undefined): Resampling | undefined {
  return segment === undefined ? undefined : 'nearest'
}

/** The TileJSON URL resolved against the page, so the worker reads the same one. */
function resolveUrl(url: string): string {
  return new URL(url, globalThis.location?.href).href
}

/** Frees an image a caller no longer waits for. */
function discard(value: unknown): void {
  if (value instanceof ImageBitmap) value.close()
}

function inlineBackend(): Backend {
  let engine: WarpEngine | undefined = new WarpEngine()
  return {
    async call(call, signal) {
      if (engine === undefined) throw new Error('The protocol has been terminated')
      const value = await runCall(engine, call, signal)
      if (signal?.aborted) {
        discard(value)
        signal.throwIfAborted()
      }
      return value
    },
    terminate() {
      engine = undefined
    },
  }
}

function workerBackend(): Backend {
  let worker: Worker | undefined
  /** Why the worker cannot answer: it failed to load, crashed or was terminated. */
  let failure: Error | undefined
  let nextId = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const fail = (error: Error) => {
    failure = error
    worker?.terminate()
    for (const call of pending.values()) call.reject(error)
    pending.clear()
  }
  const onMessage = ({ data }: MessageEvent<Response>) => {
    const call = pending.get(data.id)
    if (call === undefined) {
      // Aborted meanwhile.
      if (data.ok) discard(data.value)
      return
    }
    pending.delete(data.id)
    if (data.ok) {
      call.resolve(data.value)
    } else {
      const error = new Error(data.message)
      error.name = data.name
      call.reject(error)
    }
  }

  return {
    call(call, signal) {
      if (failure !== undefined) return Promise.reject(failure)
      if (signal?.aborted) return Promise.reject(signal.reason)
      if (worker === undefined) {
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
        worker.addEventListener('message', onMessage)
        worker.addEventListener('error', (event) => {
          fail(new Error(`The tilewarp worker failed to load or crashed: ${event.message || 'no details'}`))
        })
        worker.addEventListener('messageerror', () => {
          fail(new Error('The tilewarp worker sent a message that could not be read'))
        })
      }
      const id = nextId++
      const target = worker
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        signal?.addEventListener(
          'abort',
          () => {
            if (!pending.delete(id)) return
            target.postMessage({ method: 'cancel', target: id } satisfies Request)
            reject(signal.reason)
          },
          { once: true },
        )
      })
      target.postMessage({ ...call, id } satisfies Request)
      return result
    },
    terminate() {
      fail(new Error('The protocol has been terminated'))
    },
  }
}
