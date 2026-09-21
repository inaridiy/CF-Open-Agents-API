/**
 * Byte utilities shared by the Worker, the container routes and the model gateway. The
 * module has no imports on purpose: the gateway must stay free of the optional `ai` peer,
 * and every caller here is a platform boundary rather than a domain rule.
 */

/** Lowercase hex SHA-256 of a string (UTF-8) or of raw bytes. */
export async function sha256Hex(value: string | BufferSource): Promise<string> {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Read a body up to `limit` bytes. `overflow` says the stream held more, so a caller can
 * refuse the input instead of silently truncating it. The reader is always released; a
 * body whose fetch signal aborts rejects here rather than answering half a document.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; overflow: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), overflow: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      chunks.push(chunk.value);
      if (size > limit) {
        overflow = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.byteLength) break;
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, overflow };
}
