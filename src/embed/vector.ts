import { EMBED_DIM } from '../config.js'

export function embeddingToBuffer(embedding: number[]): Buffer {
  const floats = new Float32Array(embedding)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)
}

export function bufferToEmbedding(buf: Buffer, dim: number = EMBED_DIM): number[] {
  // readFloatLE (not a Float32Array view): a Buffer may slice a shared pool at an arbitrary
  // byteOffset, and a Float32Array view requires a 4-byte-aligned offset.
  const out = new Array<number>(dim)
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

/** Element-wise mean of same-dimension vectors (e.g. multi-part embed → one spine vector). */
export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dim = vectors[0]!.length
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`meanPool: expected dim ${dim}, got ${v.length}`)
    }
  }
  const out = new Array<number>(dim).fill(0)
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i]! += v[i]!
  }
  const n = vectors.length
  for (let i = 0; i < dim; i++) out[i]! /= n
  return out
}
