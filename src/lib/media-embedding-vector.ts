export const GEMINI_EMBEDDING_DIMENSIONS = 3_072;

const VECTOR_BYTE_LENGTH = GEMINI_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

export function encodeVector(values: unknown): Uint8Array | null {
  if (!Array.isArray(values) || values.length !== GEMINI_EMBEDDING_DIMENSIONS) return null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(Math.fround(value))) return null;
  }
  return new Uint8Array(Float32Array.from(values).buffer);
}

export function decodeVector(value: unknown): Float32Array | null {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
  if (!bytes || bytes.byteLength !== VECTOR_BYTE_LENGTH || bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
  const vector = new Float32Array(bytes.buffer, bytes.byteOffset, GEMINI_EMBEDDING_DIMENSIONS);
  return vector.every(Number.isFinite) ? vector : null;
}
