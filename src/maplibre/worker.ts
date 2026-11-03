/**
 * The Web Worker the protocol renders in: one {@link WarpEngine}, answering
 * calls in the order their awaits settle. Results are transferred. A
 * cancelled tile is not rendered if its render has not started.
 */

import { runCall, WarpEngine } from './engine.ts'
import type { Request, Response } from './rpc.ts'

/** The parts of the worker scope used here (the DOM typings lack it). */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage(message: Response, transfer: Transferable[]): void
}

const engine = new WarpEngine()
/** Calls under way, by id, to cancel. */
const running = new Map<number, AbortController>()

scope.onmessage = async ({ data }) => {
  if (data.method === 'cancel') {
    running.get(data.target)?.abort()
    return
  }
  const controller = new AbortController()
  running.set(data.id, controller)
  try {
    const value = await runCall(engine, data, controller.signal)
    const transfer = value instanceof ArrayBuffer || value instanceof ImageBitmap ? [value] : []
    scope.postMessage({ id: data.id, ok: true, value }, transfer)
  } catch (error) {
    const { name, message } = error instanceof Error ? error : new Error(String(error))
    scope.postMessage({ id: data.id, ok: false, name, message }, [])
  } finally {
    running.delete(data.id)
  }
}
