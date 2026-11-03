/** {@link Layer}s with integer coordinates → MVT bytes (version 2). */

import { PbfWriter } from 'pbf'
import type { Coords, Feature, Layer, PropertyValue } from './geometry.ts'

const MOVE_TO = 1
const LINE_TO = 2
const CLOSE_PATH = 7

export function encodeTile(layers: Layer[]): Uint8Array {
  const pbf = new PbfWriter()
  for (const layer of layers) {
    if (layer.features.length === 0) continue
    pbf.writeMessage(3, writeLayer, layer)
  }
  return pbf.finish()
}

interface Tables {
  keys: Map<string, number>
  values: Map<string, number>
  valueList: PropertyValue[]
}

function writeLayer(layer: Layer, pbf: PbfWriter): void {
  pbf.writeVarintField(15, 2)
  pbf.writeStringField(1, layer.name)
  const tables: Tables = { keys: new Map(), values: new Map(), valueList: [] }
  for (const feature of layer.features) {
    pbf.writeMessage(2, writeFeature, { feature, tables })
  }
  for (const key of tables.keys.keys()) pbf.writeStringField(3, key)
  for (const value of tables.valueList) pbf.writeMessage(4, writeValue, value)
  pbf.writeVarintField(5, layer.extent)
}

function writeFeature({ feature, tables }: { feature: Feature; tables: Tables }, pbf: PbfWriter): void {
  if (feature.id !== undefined) pbf.writeVarintField(1, feature.id)
  const tags: number[] = []
  for (const [key, value] of Object.entries(feature.properties)) {
    tags.push(index(tables.keys, key, key), index(tables.values, valueKey(value), value, tables.valueList))
  }
  pbf.writePackedVarint(2, tags)
  pbf.writeVarintField(3, feature.geometry.type)
  pbf.writePackedVarint(4, encodeGeometry(feature))
}

function index<T>(table: Map<string, number>, key: string, value: T, list?: T[]): number {
  let i = table.get(key)
  if (i === undefined) {
    i = table.size
    table.set(key, i)
    list?.push(value)
  }
  return i
}

/** Values of different types with the same text are different entries. */
function valueKey(value: PropertyValue): string {
  return `${typeof value}:${String(value)}`
}

function writeValue(value: PropertyValue, pbf: PbfWriter): void {
  switch (typeof value) {
    case 'string':
      pbf.writeStringField(1, value)
      break
    case 'boolean':
      pbf.writeBooleanField(7, value)
      break
    case 'number':
      if (Number.isSafeInteger(value)) {
        if (value >= 0) pbf.writeVarintField(5, value)
        else pbf.writeSVarintField(6, value)
      } else {
        pbf.writeDoubleField(3, value)
      }
      break
  }
}

function command(id: number, count: number): number {
  return (id & 0x7) | (count << 3)
}

function zigzag(n: number): number {
  return (n << 1) ^ (n >> 31)
}

/**
 * The geometry's command stream. Coordinates must be integers in the
 * layer's extent, rings open and with the winding already right.
 */
function encodeGeometry(feature: Feature): number[] {
  const out: number[] = []
  const cursor = { x: 0, y: 0 }
  const g = feature.geometry
  switch (g.type) {
    case 1:
      out.push(command(MOVE_TO, g.points.length / 2))
      pushDeltas(out, cursor, g.points, 0)
      break
    case 2:
      for (const line of g.lines) pushPath(out, cursor, line, false)
      break
    case 3:
      for (const polygon of g.polygons) {
        pushPath(out, cursor, polygon.exterior, true)
        for (const hole of polygon.holes) pushPath(out, cursor, hole, true)
      }
      break
  }
  return out
}

function pushPath(out: number[], cursor: { x: number; y: number }, coords: Coords, close: boolean): void {
  const n = coords.length / 2
  out.push(command(MOVE_TO, 1))
  pushDeltas(out, cursor, coords, 0, 1)
  out.push(command(LINE_TO, n - 1))
  pushDeltas(out, cursor, coords, 1)
  if (close) out.push(command(CLOSE_PATH, 1))
}

function pushDeltas(
  out: number[],
  cursor: { x: number; y: number },
  coords: Coords,
  from: number,
  to = coords.length / 2,
): void {
  for (let i = from; i < to; i++) {
    const x = coords[2 * i]
    const y = coords[2 * i + 1]
    out.push(zigzag(x - cursor.x), zigzag(y - cursor.y))
    cursor.x = x
    cursor.y = y
  }
}
