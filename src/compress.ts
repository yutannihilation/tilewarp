/** Compression through the streams API, native and fast. */

export type Format = 'gzip' | 'deflate'

// Blob copies its parts. The DOM typings reject a view that might be of a
// SharedArrayBuffer; tile bytes and encoder output never are.

export function compressStream(data: Uint8Array, format: Format): ReadableStream<Uint8Array> {
  return new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream(format))
}

export async function compress(data: Uint8Array, format: Format): Promise<Uint8Array> {
  return new Uint8Array(await new Response(compressStream(data, format)).arrayBuffer())
}

export async function decompress(parts: Uint8Array[], format: Format): Promise<Uint8Array> {
  const stream = new Blob(parts as Uint8Array<ArrayBuffer>[]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
