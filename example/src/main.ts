import { SCHEME, WarpProtocol } from '@yutannihilation/tilewarp/maplibre'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'

// MapLibre finds its worker next to its own module, which a bundle moves.
maplibregl.setWorkerUrl(maplibreWorkerUrl)

/** OpenFreeMap's Liberty style; its `openmaptiles` source is the Web Mercator vector source. */
const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
/** NASA's Blue Marble from GIBS, through the TileJSON next to this page (GIBS publishes none). */
const RASTER_SOURCE = 'blue-marble.json'

/** Added to the sources' own credits, which come with their TileJSON. */
const REPROJECTED =
  'reprojected with <a href="https://github.com/yutannihilation/tilewarp" target="_blank">tilewarp</a>'

// Places to check the tiles' alignment against.
const PLACES: [string, number, number][] = [
  ['Wellington', 174.7762, -41.2865],
  ['Nuuk', -51.7216, 64.1814],
  ['North Pole', 0, 90],
  ['South Pole', 0, -90],
  ['Ottawa', -75.6972, 45.4215],
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const form = $<HTMLFormElement>('form')
const preset = $<HTMLSelectElement>('preset')
const custom = $<HTMLInputElement>('custom')
const workerBox = $<HTMLInputElement>('worker')
const mergeBox = $<HTMLInputElement>('merge')
const bounds = $<HTMLInputElement>('bounds')
const info = $<HTMLDivElement>('info')
const statsBox = $<HTMLDivElement>('stats')

/**
 * For measuring: per-tile times (ms, request to answer) and main-thread
 * stalls, the delays over 50 ms of a 10 ms interval (blocked rendering and
 * input; `longtask` entries are not reported in every browser).
 */
const stats = { tiles: [] as number[], stalls: [] as number[] }
Object.assign(window, { tilewarpStats: stats })
let lastTick = performance.now()
setInterval(() => {
  const now = performance.now()
  if (now - lastTick - 10 > 50) stats.stalls.push(now - lastTick - 10)
  lastTick = now
}, 10)

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN
}

function showStats() {
  const t = stats.tiles
  const longest = stats.stalls.length ? Math.max(...stats.stalls) : 0
  statsBox.textContent =
    `tiles ${t.length}  median ${percentile(t, 50).toFixed(0)} ms  p90 ${percentile(t, 90).toFixed(0)} ms` +
    `  max ${(t.length ? Math.max(...t) : Number.NaN).toFixed(0)} ms\n` +
    `main-thread stalls ${stats.stalls.length}  longest ${longest.toFixed(0)} ms`
}

let protocol: WarpProtocol | undefined
let protocolInWorker: boolean | undefined
let map: maplibregl.Map | undefined

function useProtocol(inWorker: boolean): WarpProtocol {
  if (protocol === undefined || protocolInWorker !== inWorker) {
    protocol?.terminate()
    const p = new WarpProtocol({ worker: inWorker })
    maplibregl.addProtocol(SCHEME, async (params, abortController) => {
      const t0 = performance.now()
      const result = await p.tile(params, abortController)
      if (params.type !== 'json') {
        stats.tiles.push(performance.now() - t0)
        showStats()
      }
      return result
    })
    protocol = p
    protocolInWorker = inWorker
  }
  return protocol
}

async function load(epsg: number) {
  const kind = (form.elements.namedItem('kind') as RadioNodeList).value
  stats.tiles.length = 0
  stats.stalls.length = 0
  const warp = useProtocol(workerBox.checked)
  let crs: maplibregl.CRS
  try {
    crs = await warp.addCrs(epsg)
  } catch (error) {
    info.textContent = `Error: ${(error as Error).message}`
    return
  }

  // A map cannot switch to or from a registered CRS after its sources load,
  // so each CRS gets a fresh map, at its initial view: the hash only applies
  // to the first.
  if (map) {
    map.remove()
    history.replaceState(null, '', location.pathname + location.search)
  }
  try {
    maplibregl.removeProjection(crs.name)
  } catch {}
  maplibregl.addProjection(crs)

  const style = kind === 'vector' ? await vectorStyle(crs.name, epsg, mergeBox.checked) : rasterStyle(crs.name, epsg)

  const { origin, extentAtZoom0 } = crs.tileMatrixSet
  map = new maplibregl.Map({
    container: 'map',
    style,
    hash: true,
    attributionControl: { customAttribution: REPROJECTED },
    // The center of the CRS's grid, which shows the whole area of use.
    center: crs.projection.inverse([origin[0] + extentAtZoom0 / 2, origin[1] - extentAtZoom0 / 2]) as [number, number],
    zoom: 1,
  })
  map.addControl(new maplibregl.NavigationControl())
  map.showTileBoundaries = bounds.checked
  for (const [name, lng, lat] of PLACES) {
    if (!inGrid(crs, lng, lat)) continue
    new maplibregl.Marker()
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup({ offset: 25 }).setText(name))
      .addTo(map)
  }

  const merging = kind === 'vector' && mergeBox.checked ? ', merge' : ''
  const header = `${crs.name}  ${kind}${merging}, ${workerBox.checked ? 'worker' : 'main thread'}\norigin ${origin.map((v) => v.toFixed(1)).join(', ')}  extentAtZoom0 ${extentAtZoom0.toFixed(1)}`
  const current = map
  const update = (lngLat?: maplibregl.LngLat) => {
    info.textContent = `${header}\nzoom ${current.getZoom().toFixed(2)}${lngLat ? `  lng/lat ${lngLat.lng.toFixed(5)}, ${lngLat.lat.toFixed(5)}` : ''}`
  }
  map.on('mousemove', (e) => update(e.lngLat))
  map.on('zoom', () => update())
  update()
  showStats()
}

/**
 * Liberty with its vector source read through the protocol. Its hillshade is
 * a Web Mercator raster given only as a tile template, which a custom CRS
 * would draw in the wrong place, so it is left out with its layers.
 *
 * @param merge - join polygon pieces across source tiles by feature id (the URL's `merge/`)
 */
async function vectorStyle(projection: string, epsg: number, merge: boolean): Promise<maplibregl.StyleSpecification> {
  const style = (await (await fetch(VECTOR_STYLE)).json()) as maplibregl.StyleSpecification
  const vector = style.sources.openmaptiles as maplibregl.VectorSourceSpecification
  return {
    ...style,
    projection: { type: projection },
    sources: { openmaptiles: { ...vector, url: `${SCHEME}://${epsg}/${merge ? 'merge/' : ''}${vector.url}` } },
    layers: style.layers.filter((layer) => !('source' in layer) || layer.source === 'openmaptiles'),
  }
}

function rasterStyle(projection: string, epsg: number): maplibregl.StyleSpecification {
  return {
    version: 8,
    projection: { type: projection },
    sources: { imagery: { type: 'raster', url: `${SCHEME}://${epsg}/${RASTER_SOURCE}`, tileSize: 256 } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
      { id: 'imagery', type: 'raster', source: 'imagery' },
    ],
  }
}

/** Whether a place falls in the CRS's tile matrix set (and so on the map). */
function inGrid(crs: maplibregl.CRS, lng: number, lat: number): boolean {
  const { origin, extentAtZoom0 } = crs.tileMatrixSet
  const [x, y] = crs.projection.forward([lng, lat])
  const wx = (x - origin[0]) / extentAtZoom0
  const wy = (origin[1] - y) / extentAtZoom0
  return wx >= 0 && wx <= 1 && wy >= 0 && wy <= 1
}

const chosenCode = () => Number(custom.value.trim() || preset.value)
form.addEventListener('submit', (e) => {
  e.preventDefault()
  load(chosenCode())
})
form.addEventListener('change', (e) => {
  if (e.target === bounds) {
    if (map) map.showTileBoundaries = bounds.checked
    return
  }
  if (e.target === preset) custom.value = ''
  if (e.target !== custom) load(chosenCode())
})
load(chosenCode())
