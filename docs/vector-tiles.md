# How a vector tile is served

This page follows one tile request from MapLibre to the bytes it gets back:
`tilewarp://6677/https://tiles.openfreemap.org/planet/{z}/{x}/{y}.mvt`, an
output tile in EPSG:6677 from a Web Mercator source named by its TileJSON.
Two steps have pages of their own with the figures that explain them:
[choosing the source tiles](vector-source-selection.md) and [transforming a
source tile](vector-transform.md). The raster path (`.png`) shares the first
half, up to the choice of source tiles, and is not described here.

## The parts

```mermaid
flowchart LR
  client["MapLibre GL JS<br/>custom CRS (tile matrix set)"]
  subgraph main["main thread"]
    protocol["WarpProtocol<br/>src/maplibre/index.ts"]
  end
  subgraph worker["Web Worker (or the main thread with worker: false)"]
    engine["WarpEngine<br/>CRSs, sources"]
    warper["Warper<br/>source tile caches"]
    pipeline["vector pipeline<br/>src/vector.ts, src/mvt/*"]
    xyz["XyzSource<br/>src/xyz.ts"]
  end
  epsg["epsg.io<br/>PROJJSON of the code"]
  tiles["Web Mercator XYZ source<br/>TileJSON and tiles over HTTPS"]
  client -->|"addProtocol, tile request"| protocol
  protocol -.->|"addCrs, once per CRS"| epsg
  protocol -->|"postMessage"| engine --> warper --> pipeline
  warper --> xyz -->|"fetch"| tiles
```

- The client is MapLibre with a CRS registered through `addProjection`,
  from what `WarpProtocol.addCrs` returns. Its source is a
  `tilewarp://{epsg}/{TileJSON URL}` URL; the protocol answers it with the
  reprojected TileJSON, whose `tiles` template points back at the protocol
  with `.mvt` for a vector source (one with `vector_layers`) or `.png` for a
  raster one.
- The protocol runs on the main thread, where it parses URLs and, in
  `addCrs`, fetches the PROJJSON and builds the CRS once. Every call
  (`addCrs` with that PROJJSON, the TileJSON, a tile) is posted to a Web Worker it creates on
  first use, and the answer is transferred back. With `worker: false` the
  same engine runs on the main thread instead.
- The engine (`WarpEngine`) keeps the CRSs added, one `XyzSource` per
  TileJSON URL, and one `Warper`, which caches the source tiles it has
  decoded and prepared. Nothing is kept between page loads; a tile MapLibre
  asks for twice is warped twice, from cached source tiles.
- The source is any Web Mercator XYZ server with a TileJSON: `XyzSource`
  fills its tile URL template and fetches each tile over HTTPS, so the server
  must allow cross-origin requests.

The same pipeline runs outside the browser through the core API: a
`Warper` with any `MercatorSource` (`XyzSource`, or your own, such as a
reader for a PMTiles archive) and a `Crs` from `resolveCrs`.

## One request, start to end

```mermaid
sequenceDiagram
  participant M as MapLibre
  participant P as WarpProtocol (main thread)
  participant W as Web Worker (WarpEngine)
  participant E as epsg.io
  participant S as Tile source (HTTPS)
  M->>P: addCrs(6677)
  P->>E: GET /6677.json (once per CRS)
  E-->>P: PROJJSON with the area of use
  P->>P: build the CRS: proj4 converters, tile matrix set
  P->>W: addCrs with the PROJJSON
  P-->>M: projection for addProjection
  M->>P: tilewarp://6677/…/planet (TileJSON)
  P->>W: tileJson
  W->>S: GET the source's TileJSON (once per URL)
  W-->>P: reprojected TileJSON (tiles template, vector_layers, maxzoom)
  P-->>M: TileJSON
  M->>P: tilewarp://6677/…/planet/10/513/272.mvt
  P->>W: tile 10/513/272 (cancelled if MapLibre aborts)
  W->>W: field over the tile + buffer → source zoom and tiles
  W->>S: GET each source tile not yet prepared (parallel)
  W->>W: decode, classify rings, pre-clip, cache
  W->>W: transform, densify, clip, quantize, winding, merge, encode
  W-->>P: MVT bytes (transferred)
  P-->>M: tile
```

The steps below are the warp's own work, in order.

### 1. The CRS and the output tile's frame

The CRS is an EPSG code. Its PROJJSON, from epsg.io unless `addCrs` is given
one, gives proj4 the definition and gives the warp the area of use
(epsg.io's `bbox`), from which the tile matrix set is derived
(`tmsFromAreaOfUse`): the smallest square around the projected area of use,
with tile 0/0/0 as that square. The protocol returns the same square to
`addProjection`, so MapLibre and the warp agree on where tile `z/x/y` is.
A geocentric CRS (one with no plane to tile) or a PROJJSON without an area
of use is rejected with `CrsError`.

From the tile matrix set, `tileAffine` gives the affine from output tile
units (0 to 8192, y down) to CRS coordinates. Its inverse is the last step of
every coordinate's journey.

### 2. Which source tiles to read

The warp needs the Web Mercator tiles under the output tile. The output
tile's shape in Mercator is curved, may contain a pole, may straddle the
antimeridian, and may reach outside the CRS's domain, so the four corners are
not enough. Instead, a grid of 64 × 64 cells is laid over the output tile and
its 128-unit buffer, and the cells' corners, 65 × 65 samples, are projected
to Mercator (`mercatorField`, shared with the raster path). Samples with no
Mercator position are left out: beyond ±85° of latitude, or where the CRS
has no such point.

![The field over the output tile and the source tiles it touches](figures/source-tiles.svg)

From the field come, in order:

- **The source zoom**: the one whose tiles have about the same ground size
  as the output tile (0.71 to 1.41 times), from the median cell size in
  Mercator meters, clamped to the source's zoom range (the TileJSON's
  `minzoom` and `maxzoom`) and lowered until at most 16 tiles are needed.
  Above the source's maximum zoom the output tile reads a small part of a
  maximum-zoom tile (overzoom).
- **The tiles to read**: those some cell reaches into.
- **A coverage per tile**: the box around the cells that reach into it, in
  fractions of the tile. Only features whose bounding box meets it are
  transformed, and each of those is clipped to it first. Where a cell's
  corner has no position (past the latitude limit, outside a world
  projection's limb), the cell's edges from its positioned corners are
  bisected to where the positions end, so the box reaches the data's edge.

[Choosing the source tiles](vector-source-selection.md) shows each of these
with a figure.

### 3. Reading and preparing a source tile

Source tiles are read in parallel through the source's `tile(z, x, y)`. For
`XyzSource` that is one HTTPS request each; 404, 204 and an empty body mean
no tile there, and gzipped bytes are gunzipped even without
`Content-Encoding`. A missing tile is an empty one; any other HTTP error or
a failed request (network, CORS) fails the output tile with `UpstreamError`,
and bytes that do not gunzip with `SourceError`.

A prepared source tile is target-independent, so the `Warper` keeps it in a
cache bounded by its estimated size (32 MB in the protocol's engine), where
the neighbouring output tiles that read the same source tiles find it.
Reads under way are shared too, so concurrent output tiles do not fetch a
source tile twice, and a read MapLibre aborts still finishes and is kept.
Preparing means:

- **Decode** the MVT with `@mapbox/vector-tile`: layers, features, ids,
  properties, integer geometry in the tile's extent (4096 for OpenMapTiles
  and Protomaps tiles).
- **Classify rings** of polygons into exteriors and holes right away, by
  winding, with the same rule MapLibre uses. The source is Web Mercator, so
  its winding is trustworthy; after reprojection it may not be. The role is
  carried with each ring from here on.
- **Pre-clip** every feature to the tile's own unbuffered extent, so that
  what neighbouring source tiles contribute abuts instead of overlapping.
- **Insert touches**: a vertex of a polygon lying on one of its edges is
  added to that edge, so that rounding cannot pull them apart (below).

![Pre-clip of neighbouring source tiles](figures/preclip.svg)

Polygons are pre-clipped (and clipped to the coverage) with `clipPolygon`,
not Sutherland–Hodgman. A polygon that the edge cuts into several pieces
comes out as several polygons. Sutherland–Hodgman would keep one ring and
join the pieces with zero-width bridges running along the edge and back.
Such a bridge is harmless where it is drawn, but the transform maps its two
passes through different vertices (each is densified and rounded on its
own), so on a curved projection they cross. The ring then intersects itself,
and MapLibre's triangulation (earcut) fills large triangles that are not in
the polygon.

Wherever a vertex of a polygon lies exactly on one of the polygon's edges
(a hole touching its exterior, say), it is added to that edge
(`insertTouches`). A vertex on an edge has no clearance from it: after the
transform and rounding it can land on either side, and the rings cross. The
same point as a vertex of both rings always lands in one place. In the
source's integer coordinates the test is exact.

[Why a valid polygon can come out with a stray triangle](polygon-pitfalls.md)
shows both problems on real tiles, with figures, and what they looked like on
the map.

### 4. The transform

Each source tile gets one transform from its own units to output tile units:
an affine into Mercator meters, proj4 from Mercator into the CRS, and the
inverse of the output tile's affine. Doubles are used throughout; coordinates
become integers only at the end.

![The chain of transforms](figures/transform-chain.svg)

proj4 transforms points, and for a point outside a projection's domain it may
answer with a finite position somewhere else (transverse Mercator far from
its meridian, say). The _checked_ variant projects the answer back and
accepts it only if it returns to the input; otherwise the point has no image.
That doubles the proj4 work, so before transforming a tile, a 9 × 9 grid of
its points is tried with the checked transform. If every grid point has an
image, the tile lies inside the domain and is transformed unchecked. The grid
also measures how much the transform bends, which gives the longest segment
the tile bends by no more than one output unit: its _segment limit_.

### 5. Densification

A straight segment in the source is a curve in the target. A segment whose
image is no longer than the tile's segment limit is kept as it is. Any other
is subdivided adaptively in source coordinates: the midpoint is transformed
and compared with the midpoint of the transformed endpoints; if they differ
by more than one output unit, the midpoint is kept and both halves are tried
again, to a depth of eight.

![Adaptive densification](figures/densify.svg)

Where a vertex or a midpoint has no image, or where at the recursion limit a
tiny piece still jumps across half the tile matrix set (a projection seam),
a line is split and a ring is dropped.

[Transforming a source tile](vector-transform.md) shows the grid test, the
segment limit and the densification with figures.

### 6. Clip, quantize, winding

The transformed geometry is clipped to the output tile plus its buffer, an
axis-aligned rectangle in output units: Cohen–Sutherland for lines (a line
that leaves and comes back becomes several), Sutherland–Hodgman for rings
(edges may run along the rectangle, which MVT accepts; here the bridges are
already in output units, on lines that rounding leaves straight, so their two
passes stay on top of each other). Coordinates are then
rounded to integers, repeated points removed, lines with fewer than two
points and rings with fewer than three or no area dropped, and a polygon
whose exterior is gone takes its holes with it.

![Clip, quantize and fix the winding](figures/clip-quantize-winding.svg)

Finally the winding: by the MVT spec's surveyor's formula in y-down
coordinates, an exterior ring has positive area and a hole negative. Any ring
whose sign does not match the role recorded at decode time is reversed.
Reflected axes, singularities and rounding are the usual causes.

### 7. Encode and answer

Features are merged by layer name across the source tiles, each layer's
key and value tables are rebuilt, and the tile is written as MVT version 2
with extent 8192 by a small encoder on `pbf`. That is MapLibre's internal
grid, so the client uses the coordinates as they are, and twice the source's
4096, so rounding moves vertices half as far as at 4096. Ids and properties
pass through unchanged. The bytes are returned uncompressed: the worker
transfers them to the protocol, which hands them to MapLibre. An output tile
with nothing in it is an empty MVT, not an error. (A server built on the
core API compresses the bytes itself; `compress` and `compressStream` are
there for it.)

## The pipeline at a glance

```mermaid
flowchart TD
  subgraph per_request["per output tile"]
    A["field: 65 × 65 samples over tile + buffer<br/>mercatorField"] --> B["source zoom and tiles<br/>chooseSourceZoom"]
    B --> C["coverage per source tile, cell by cell<br/>sourceCoverage"]
    C --> D["transform per source tile<br/>grid → checked or unchecked, segment limit"]
    D --> E["clip features to the coverage<br/>clipGeometry"]
    E --> F["transform + densify<br/>transformLine, transformRing"]
    F --> G["clip to tile + buffer<br/>clipLine, clipRing"]
    G --> H["quantize, winding<br/>quantizeLine, quantizePolygon"]
    H --> I["merge by layer, encode<br/>encodeTile"]
    I --> J["MVT bytes to the caller"]
  end
  subgraph per_source_tile["per source tile, cached by the Warper"]
    R["fetch<br/>XyzSource.tile"] --> S["decode + classify rings<br/>decodeTile"]
    S --> T["pre-clip to own extent, insert touches<br/>prepareSourceTile"]
  end
  B -.->|"load"| R
  T -.-> D
```

| Where                                         | What                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/maplibre/index.ts`                       | the protocol: URLs, `addCrs`, the worker and its calls                         |
| `src/maplibre/engine.ts`, `worker.ts`         | the engine the calls run on: CRSs, sources, the `Warper`; the worker around it |
| `src/xyz.ts`                                  | an HTTPS XYZ source from a TileJSON                                            |
| `src/warper.ts`                               | source tile caches, the raster render                                          |
| `src/decode.ts`                               | raster source tiles: 8-bit PNG in JS, the rest with the browser                |
| `src/crs.ts`                                  | CRS from PROJJSON, checked projections                                         |
| `src/tms.ts`                                  | tile matrix set and tile affines                                               |
| `src/warp.ts`                                 | the field and the source zoom choice (shared with raster)                      |
| `src/vector.ts`                               | the pipeline: coverage, transform choice, reproject, merge                     |
| `src/mvt/decode.ts`, `encode.ts`              | MVT in and out                                                                 |
| `src/mvt/clip.ts`, `transform.ts`, `clean.ts` | clipping, densification, touches, quantization and winding                     |

## Known limitations

- Lines and polygon outlines are split at source tile boundaries. Fills are
  not affected, but strokes, dashes and line labels are. A polygon is cut
  along the boundary (the pre-clip above), and the cut is an edge of each
  piece like any other, inside the output tile. A fill layer whose
  `fill-outline-color` differs from its `fill-color` therefore draws a thin
  line along every source tile boundary that crosses the polygon, a grid of
  meridians and parallels over a large one. In OpenFreeMap's Liberty style
  the `park` layer does (a green outline), which shows over the Northeast
  Greenland National Park
  ([picture](vector-source-selection.md#where-the-zoom-changes)). Layers with
  `fill-antialias: false`, or with no outline color of their own, show
  nothing.
- Neighbouring output tiles can read different source zooms, and a source
  generalized per zoom then shows a visible break along the output tile
  edges between them
  ([details](vector-source-selection.md#where-the-zoom-changes)).
- A ring with any vertex outside the CRS's domain is dropped whole.
- Edges of a polygon that come within about one output unit of each other
  without touching (a narrow neck, a hole close to its exterior) can cross
  after rounding to integers, and MapLibre may then fill a small wrong
  triangle there ([details](polygon-pitfalls.md#2-rounding-touching-rings-and-near-misses)).
- A projection whose seam falls inside a source tile (an Equal Earth not
  centered on Greenwich) splits lines and drops rings there.
- An output tile whose data is a strip thinner than a field cell (about 130
  units, 4 px) at the latitude limit or a world projection's limb, with no
  field sample in it, is served empty.
- CPU time is dominated by proj4. A dense tile takes tens of milliseconds,
  which is why the protocol warps in a Web Worker by default; the README
  has measurements.
