/**
 * Per-request timing breakdown of an output tile, `.mvt` or `.png`. `Warper`
 * and `renderVectorTile` fill in the stages they run, the source zoom, the
 * tile counts and the MVT size. `misses` is counted by `Warper`'s source tile
 * reads, so it stays 0 when `renderVectorTile` is given another loader.
 * `crs`, `total` and the raster `encode` are left to the caller,
 * which runs those steps. Stages are measured once per request, around whole
 * steps. The formatters turn a breakdown into a one-line console summary or
 * a `Server-Timing` header value (for browser DevTools).
 */

/** Timing breakdown (ms) and counts for one `.mvt` tile request. */
export interface VectorTiming {
  crs: number
  /** The field and the coverage: which source tiles to read, and where in them. */
  field: number
  /** Reading the source tiles, including decoding and pre-clipping the ones not cached. */
  fetch: number
  /** Transforming, densifying, clipping and quantizing every feature. */
  transform: number
  encode: number
  total: number
  sourceZoom?: number
  tiles: number
  misses: number
  bytes: number
}

/** Timing breakdown (ms) and counts for one `.png` tile request. */
export interface RasterTiming {
  crs: number
  field: number
  zoom: number
  fetch: number
  sample: number
  encode: number
  total: number
  sourceZoom?: number
  tiles: number
  misses: number
}

export function createVectorTiming(): VectorTiming {
  return { crs: 0, field: 0, fetch: 0, transform: 0, encode: 0, total: 0, tiles: 0, misses: 0, bytes: 0 }
}

export function createRasterTiming(): RasterTiming {
  return {
    crs: 0,
    field: 0,
    zoom: 0,
    fetch: 0,
    sample: 0,
    encode: 0,
    total: 0,
    tiles: 0,
    misses: 0,
  }
}

function metric(name: string, dur: number, desc: string): string {
  return `${name};dur=${dur.toFixed(1)};desc="${desc}"`
}

/** `Server-Timing` header value for a vector tile response. */
export function vectorServerTiming(t: VectorTiming): string {
  const srcDesc = t.sourceZoom === undefined ? 'empty' : `z${t.sourceZoom}, ${t.tiles} tiles`
  return [
    metric('crs', t.crs, 'CRS & source'),
    metric('field', t.field, `Field & coverage (${srcDesc})`),
    metric('fetch', t.fetch, `Fetch & prepare (${t.misses}/${t.tiles} miss)`),
    metric('transform', t.transform, 'Transform, clip & quantize'),
    metric('encode', t.encode, 'MVT encode'),
    metric('total', t.total, 'Total'),
  ].join(', ')
}

/** One-line console summary for a vector tile request. */
export function formatVectorTiming(epsg: number, z: number, x: number, y: number, t: VectorTiming): string {
  const src = t.sourceZoom === undefined ? 'empty' : `z${t.sourceZoom} tiles=${t.tiles} miss=${t.misses}`
  const stages = [
    ['crs', t.crs],
    ['field', t.field],
    ['fetch', t.fetch],
    ['transform', t.transform],
    ['encode', t.encode],
  ]
    .map(([k, v]) => `${k}=${(v as number).toFixed(1)}`)
    .join(' ')
  return `[mvt] epsg=${epsg} ${z}/${x}/${y} ${t.total.toFixed(1)}ms (${src} | ${stages} | ${(t.bytes / 1024).toFixed(1)}KB)`
}

/** `Server-Timing` header value for a raster tile response. */
export function rasterServerTiming(t: RasterTiming): string {
  const srcDesc = t.sourceZoom === undefined ? 'empty' : `z${t.sourceZoom}, ${t.tiles} tiles`
  return [
    metric('crs', t.crs, 'CRS & source'),
    metric('field', t.field, 'Mercator field'),
    metric('zoom', t.zoom, `Source zoom (${srcDesc})`),
    metric('fetch', t.fetch, `Fetch & decode (${t.misses}/${t.tiles} miss)`),
    metric('sample', t.sample, 'Bilinear sample'),
    metric('encode', t.encode, 'PNG encode'),
    metric('total', t.total, 'Total'),
  ].join(', ')
}

/** One-line console summary for a raster tile request. */
export function formatRasterTiming(epsg: number, z: number, x: number, y: number, t: RasterTiming): string {
  const src = t.sourceZoom === undefined ? 'empty' : `z${t.sourceZoom} tiles=${t.tiles} miss=${t.misses}`
  const stages = [
    ['crs', t.crs],
    ['field', t.field],
    ['zoom', t.zoom],
    ['fetch', t.fetch],
    ['sample', t.sample],
    ['encode', t.encode],
  ]
    .map(([k, v]) => `${k}=${(v as number).toFixed(1)}`)
    .join(' ')
  return `[png] epsg=${epsg} ${z}/${x}/${y} ${t.total.toFixed(1)}ms (${src} | ${stages})`
}
