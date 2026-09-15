/** Fetch only after the caller verifies this URL belongs to the active assignment. */
export async function fetchAssignedImage(url: string, signal: AbortSignal): Promise<Response> {
  const source = new URL(url);
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password)
    return new Response("Invalid image URL", { status: 400 });
  const response = await fetch(source, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const type = response.headers.get("content-type")?.split(";")[0];
  if (!response.ok || !response.body || !type?.startsWith("image/"))
    return new Response("Image unavailable", { status: 422 });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value as Uint8Array;
      size += value.byteLength;
      if (size > 1_000_000) return new Response("Image exceeds 1 MB", { status: 413 });
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, {
      headers: { "content-type": type, "content-length": String(size) },
    });
  } finally {
    await reader.cancel();
  }
}
