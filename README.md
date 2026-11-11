# tilewarp

Reproject Web Mercator XYZ tiles into an arbitrary CRS, one output tile at a
time, for MapLibre GL JS's
[custom CRS](https://maplibre.org/maplibre-gl-js/docs/guides/custom-crs/):
vector tiles (MVT) feature by feature, raster tiles (PNG, JPEG, WebP) by
resampling.

MapLibre can show a map in a registered CRS, but it does not reproject tile
content. For an output tile in the CRS's grid, tilewarp fetches the Web
Mercator source tiles under it from an HTTPS XYZ source, warps them, and
returns the tile. It runs in the browser as a MapLibre protocol, or anywhere
`fetch` runs (tilewarper serves the same warp from Cloudflare Workers).

## MapLibre GL JS

```ts
import * as maplibregl from 'maplibre-gl'
import { SCHEME, WarpProtocol } from '@yutannihilation/tilewarp/maplibre'

const protocol = new WarpProtocol()
maplibregl.addProtocol(SCHEME, protocol.tile)
// Before the map loads sources in this CRS. The CRS's definition comes from
// epsg.io unless given as PROJJSON (with epsg.io's `bbox`, the area of use).
maplibregl.addProjection(await protocol.addCrs(6677))

new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    projection: { type: 'EPSG:6677' },
    sources: {
      // tilewarp://{EPSG code}/{TileJSON URL of the Web Mercator source}
      openmaptiles: { type: 'vector', url: 'tilewarp://6677/https://tiles.openfreemap.org/planet' },
    },
    layers: [
      /* layers for the source's schema, as for the Mercator source */
    ],
  },
})
```

- **Sources.** A source is named by its TileJSON URL (absolute, or relative
  to the page). The protocol answers with the reprojected TileJSON: its tiles
  are `tilewarp://…/{z}/{x}/{y}.mvt` for a vector source (one with
  `vector_layers`) or `.png` for a raster one, and it carries the source's
  `attribution`, layers and the zoom beyond which the map overzooms. A source
  without a TileJSON needs one written for it (see `example/public/blue-marble.json`).
- **Merging polygons.** A polygon that spans several source tiles arrives as
  one piece per tile, and a fill layer with its own `fill-outline-color`
  draws the cuts between them. With `merge/` before the TileJSON URL, the
  pieces with the same feature id are joined again:

  ```ts
  openmaptiles: { type: 'vector', url: 'tilewarp://6677/merge/https://tiles.openfreemap.org/planet' }
  ```

  It is off by default. In the tiles measured the transform took about 1 to
  3 times as long (median 1.6), most where a tile holds little besides large
  polygons. It needs feature ids that agree across tiles; a polygon
  whose pieces do not fit together is left as it is, and so are lines. A
  relative TileJSON URL that itself starts with `merge/` is written
  `./merge/…`. See [how it works](docs/vector-tiles.md#joining-the-pieces-again-merge).
- **Source tiles.** `{z}`, `{x}`, `{y}`, `{-y}` and `scheme: "tms"` are
  understood. 404, 204 and an empty body mean no tile there; gzipped tiles
  are gunzipped even without `Content-Encoding`. Other HTTP errors and failed
  requests fail the output tile with `UpstreamError`; a malformed TileJSON or
  a tile that does not decode, with `SourceError`. The source must allow
  cross-origin requests (CORS).
- **The grid.** The tile matrix set is the smallest square around the CRS's
  area of use. `addCrs` returns it, and the protocol uses the same one, so the
  map and the tiles agree. Zoom levels are the CRS's own.
- **Threads.** Tiles are warped in a Web Worker the protocol creates. With
  `new WarpProtocol({ worker: false })` they are warped on the main thread
  instead, which blocks rendering while a tile is warped. `terminate()` stops
  the worker. A tile MapLibre aborts before its source tiles are all in is
  not rendered; a render under way runs to the end. Source tiles already being
  fetched still arrive and are kept, since neighboring tiles share them.
- **Bundlers.** The worker is loaded with
  `new Worker(new URL('./worker.js', import.meta.url))`. Vite needs the
  package excluded from pre-bundling, and MapLibre's own worker URL set:

  ```ts
  // vite.config.ts
  export default defineConfig({ optimizeDeps: { exclude: ['@yutannihilation/tilewarp'] } })
  // main.ts
  import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
  maplibregl.setWorkerUrl(maplibreWorkerUrl)
  ```

- **Browsers.** Needs `CompressionStream`, `OffscreenCanvas` and
  `createImageBitmap` in workers (Safari 16.4 and later).

## Attribution

The reprojected TileJSON passes on the source's `attribution`. Tiles derived
from OpenStreetMap data are derived works under the ODbL: keep the credit, and
state that the tiles were reprojected (for example with the attribution
control's `customAttribution`).

## Core API

`@yutannihilation/tilewarp` itself has no MapLibre dependency and runs wherever
`fetch`, `CompressionStream` and `DecompressionStream` do.

```ts
import {
  browserDecoder,
  createVectorTiming,
  resolveCrs,
  Warper,
  xyzSourceFromTileJson,
} from '@yutannihilation/tilewarp'

const crs = await resolveCrs(6677, (url) => fetch(url))
const source = await xyzSourceFromTileJson('https://tiles.openfreemap.org/planet')
const warper = new Warper({
  decode: browserDecoder,
  maxSourceBytes: 8 * 2 ** 20,
  rasterCacheBytes: 16 * 2 ** 20,
  vectorCacheBytes: 32 * 2 ** 20,
})
const mvt = await warper.renderVectorTile(crs, source, 3, 4, 3, createVectorTiming())
```

`Warper` reads any `MercatorSource` (`id`, `minzoom`, `maxzoom`, `tileSize`
and `tile(z, x, y)`): `XyzSource` for HTTPS, or your own, such as a reader for
a PMTiles archive. It keeps the source tiles it decoded in memory, within the
budgets given. A vector source with `merge: true`
(`xyzSourceFromTileJson(url, { merge: true })`) has its polygons' pieces
joined across source tiles by feature id. Raster decoding is injected: `browserDecoder` decodes 8-bit PNG
in JS and everything else with the browser.

## How it works

Vector tiles are reprojected feature by feature;
[docs/vector-tiles.md](docs/vector-tiles.md) follows one tile through the
pipeline, with figures, from the protocol and its worker to the MVT bytes, and
lists its limitations. Two steps have pages of their own: [choosing the
source tiles](docs/vector-source-selection.md) and [transforming a source
tile](docs/vector-transform.md). [docs/polygon-pitfalls.md](docs/polygon-pitfalls.md)
explains the two ways a reprojected polygon used to come out with stray
triangles, and the fixes.

## Example

`example/` is a Vite page with a few CRSs, OpenFreeMap's Liberty style
(vector) and NASA's Blue Marble from [GIBS](https://nasa-gibs.github.io/gibs-api-docs/)
(raster), a worker toggle, and per-tile times and main-thread stalls for
measuring.

```sh
bun install
bun run build
bun run dev
```

Measured in Chromium 152 on a desktop Mac, production build, 2026-11-03,
with an earlier version of the example that also offered EPSG:6677:

| Run                                                                                       | Tiles | Median | p90    | Main-thread stalls > 50 ms |
| ----------------------------------------------------------------------------------------- | ----- | ------ | ------ | -------------------------- |
| OpenFreeMap, EPSG:6677, Tokyo, zoom 9, three pans and a zoom-out, worker, cold HTTP cache | 27    | 414 ms | 677 ms | none                       |
| Same, worker, warm HTTP cache                                                             | 25    | 51 ms  | 164 ms | none                       |
| Same, main thread, warm HTTP cache                                                        | 19    | 40 ms  | 179 ms | 3 (50–159 ms)              |

Per-tile time runs from the request to the answer and includes fetching the
source tiles. Stalls are delays of a 10 ms interval on the main thread, so
they cover rendering and input.

Bundle sizes, minified and gzipped: `@yutannihilation/tilewarp` 194 kB / 64 kB,
`/maplibre` (main thread) 194 kB / 64 kB, the worker 192 kB / 63 kB; proj4 is
135 kB / 43 kB of each.

## Known limitations

- Lines and polygon outlines are split at source tile boundaries; fills are
  not affected. `merge` joins polygons again where their feature ids agree
  across tiles.
- A tile is warped from scratch whenever MapLibre asks for it; only the source
  tiles are cached.
- The custom CRS API of MapLibre GL JS is experimental and may change in a
  minor release.
- Checked in Chromium only so far.

## License

MIT, except the EPSG definitions in `test/fixtures/`, which come from the EPSG
Dataset under its own terms of use (see [test/fixtures/README.md](test/fixtures/README.md)).
