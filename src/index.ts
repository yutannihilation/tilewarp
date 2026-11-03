/**
 * Reprojecting Web Mercator XYZ tiles into a custom CRS, one output tile at a time:
 * raster tiles by resampling, vector tiles feature by feature. Runs wherever
 * `fetch`, `CompressionStream` and `DecompressionStream` do (browsers, their
 * workers, Node, Cloudflare Workers). For MapLibre GL JS, see
 * `@yutannihilation/tilewarp/maplibre`.
 */

export type { Format } from './compress.ts'
export { compress, compressStream, decompress } from './compress.ts'
export type { Crs, EpsgProjJson, FetchJson } from './crs.ts'
export { buildCrs, fetchEpsgProjJson, NO_POSITION, resolveCrs } from './crs.ts'
export { browserDecoder } from './decode.ts'
export { CrsError, SourceError, UpstreamError } from './errors.ts'
export type { RgbaImage } from './png.ts'
export { decodePngToRgba, encodeRgbaToPng } from './png.ts'
export type { MercatorSource, RasterDecoder, TileSource } from './source.ts'
export type { RasterTiming, VectorTiming } from './timing.ts'
export {
  createRasterTiming,
  createVectorTiming,
  formatRasterTiming,
  formatVectorTiming,
  rasterServerTiming,
  vectorServerTiming,
} from './timing.ts'
export type { TileMatrixSet } from './tms.ts'
export { tileAffine, tmsFromAreaOfUse } from './tms.ts'
export type { SourceTile } from './vector.ts'
export { OUTPUT_EXTENT, prepareSourceTile, renderVectorTile, vectorMaxZoom } from './vector.ts'
export type { WarperOptions } from './warper.ts'
export { TILE_SIZE, Warper } from './warper.ts'
export type { XyzSourceOptions } from './xyz.ts'
export { XyzSource, xyzSourceFromTileJson } from './xyz.ts'
