/** The CRS cannot be served: unknown, or not a plane to tile. */
export class CrsError extends Error {}

/** An upstream service failed: epsg.io, or the tile source's server. */
export class UpstreamError extends Error {}

/**
 * The tile source answers with something the warp cannot use: a malformed
 * TileJSON, a tile that does not decode, a raster tile of the wrong size.
 */
export class SourceError extends Error {}
