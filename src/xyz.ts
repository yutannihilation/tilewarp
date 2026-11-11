/** A Web Mercator XYZ tile source over HTTPS, as a TileJSON describes it. */

import { decompress } from './compress.ts'
import { SourceError, UpstreamError } from './errors.ts'
import type { MercatorSource } from './source.ts'

/** What a source needs, in TileJSON's terms. */
export interface XyzSourceOptions {
  /** Tile URL templates with `{z}`, `{x}` and `{y}` (or `{-y}`); the first is used. */
  tiles: string[]
  /** Default 0. */
  minzoom?: number
  /** Default 30, as in TileJSON. */
  maxzoom?: number
  /** `tms` counts rows from the south. Default `xyz`. */
  scheme?: 'xyz' | 'tms'
  /** Raster tile size in pixels (a MapLibre extension of TileJSON). Default 256. */
  tileSize?: number
  /** Present for a vector source: its layers, passed on to the reprojected TileJSON. */
  vector_layers?: unknown[]
  attribution?: string
  /**
   * Vector only. Join the pieces of a polygon that source tile boundaries
   * cut, where they have the same feature id. Default false.
   */
  merge?: boolean
}

export class XyzSource implements MercatorSource {
  /** The template, scheme and tile size: sources that agree on all three share cached tiles. */
  readonly id: string
  /** The tile URL template used. */
  readonly template: string
  readonly minzoom: number
  readonly maxzoom: number
  readonly tileSize: number
  readonly scheme: 'xyz' | 'tms'
  readonly vectorLayers: unknown[] | undefined
  readonly attribution: string | undefined
  readonly merge: boolean

  constructor(options: XyzSourceOptions) {
    const [template] = options.tiles
    if (template === undefined) throw new SourceError('The source has no tile URL template')
    this.template = template
    this.minzoom = options.minzoom ?? 0
    this.maxzoom = options.maxzoom ?? 30
    this.tileSize = options.tileSize ?? 256
    this.scheme = options.scheme ?? 'xyz'
    this.id = `${template} ${this.scheme} ${this.tileSize}`
    this.vectorLayers = options.vector_layers
    this.attribution = options.attribution
    this.merge = options.merge ?? false
  }

  /** The tile's URL. */
  url(z: number, x: number, y: number): string {
    const row = this.scheme === 'tms' ? 2 ** z - 1 - y : y
    return this.template
      .replaceAll('{z}', String(z))
      .replaceAll('{x}', String(x))
      .replaceAll('{y}', String(row))
      .replaceAll('{-y}', String(2 ** z - 1 - y))
  }

  /**
   * The tile's bytes; `null` for 404, 204 or an empty body. Gzipped bytes are
   * gunzipped: some servers send gzipped tiles without `Content-Encoding`.
   *
   * @throws {UpstreamError} For any other HTTP error or a failed request.
   * @throws {SourceError} If gzipped bytes do not gunzip.
   */
  async tile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    const url = this.url(z, x, y)
    const response = await request(url)
    if (response.status === 404 || response.status === 204) return null
    if (!response.ok) throw new UpstreamError(`HTTP ${response.status} for ${url}`)
    const bytes = new Uint8Array(await body(response, url, (r) => r.arrayBuffer()))
    if (bytes.length === 0) return null
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
    try {
      return await decompress([bytes], 'gzip')
    } catch (error) {
      throw new SourceError(`${url} is not valid gzip`, { cause: error })
    }
  }
}

/**
 * The source a TileJSON describes. Relative tile URLs are resolved against
 * the TileJSON's URL.
 *
 * @param options - what the TileJSON does not say: whether to merge polygon
 *   pieces by feature id
 * @throws {UpstreamError} If the TileJSON cannot be fetched.
 * @throws {SourceError} If it is not JSON or has no tile URL.
 */
export async function xyzSourceFromTileJson(
  url: string,
  options: Pick<XyzSourceOptions, 'merge'> = {},
): Promise<XyzSource> {
  const response = await request(url)
  if (!response.ok) throw new UpstreamError(`HTTP ${response.status} for ${url}`)
  const text = await body(response, url, (r) => r.text())
  let tileJson: Partial<XyzSourceOptions>
  try {
    tileJson = JSON.parse(text)
  } catch (error) {
    throw new SourceError(`${url} is not JSON`, { cause: error })
  }
  if (!Array.isArray(tileJson.tiles)) throw new SourceError(`${url} is not a TileJSON with tiles`)
  return new XyzSource({
    ...tileJson,
    // Not the TileJSON's to say.
    merge: options.merge,
    tiles: tileJson.tiles.map((template) => resolveTemplate(template, url)),
  })
}

/** `fetch`, with a failed request (network, CORS) as an {@link UpstreamError}. */
async function request(url: string): Promise<Response> {
  try {
    return await fetch(url)
  } catch (error) {
    throw new UpstreamError(`Failed to fetch ${url}`, { cause: error })
  }
}

/** A response's body, with a failed read (a connection cut mid-body) as an {@link UpstreamError}. */
async function body<T>(response: Response, url: string, read: (response: Response) => Promise<T>): Promise<T> {
  try {
    return await read(response)
  } catch (error) {
    throw new UpstreamError(`Failed to read ${url}`, { cause: error })
  }
}

/** A template resolved against a base URL, its placeholders kept (URL parsing would escape the braces). */
function resolveTemplate(template: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(template)) return template
  return new URL(template, base).href.replace(/%7B(z|x|y|-y)%7D/g, '{$1}')
}
