/** Messages between the protocol on the main thread and its Web Worker. */

import type { EpsgProjJson } from '../crs.ts'
import type { Resampling } from '../source.ts'
import type { TileRequest } from './engine.ts'

export type Call =
  | { method: 'addCrs'; epsg: number; projjson: EpsgProjJson }
  | { method: 'tileJson'; epsg: number; source: string; url: string; resampling?: Resampling }
  | { method: 'tile'; request: TileRequest }

/** A call, or the cancellation of the call with id `target` (answered with nothing). */
export type Request = (Call & { id: number }) | { method: 'cancel'; target: number }

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; name: string; message: string }
