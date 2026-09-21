import { readBounded } from "./bytes.js";

const IMAGE_LIMIT = 1_000_000;
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
  const { bytes, overflow } = await readBounded(response.body, IMAGE_LIMIT);
  if (overflow) return new Response("Image exceeds 1 MB", { status: 413 });
  return new Response(bytes, {
    headers: { "content-type": type, "content-length": String(bytes.byteLength) },
  });
}
