import { z } from "zod";

import { Buffer } from "./buffer.js";

const dataImage = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/;
/** Inline image data forwarded to a native runtime; base64 text, so ~15 MiB decoded. */
const INLINE_IMAGE_LIMIT = 20 * 1024 * 1024;
/** Remote images pass through an assignment-scoped Worker proxy; native homes have no credentials. */
export async function imageContent(
  url: string,
  signal: AbortSignal,
  endpoint = "http://media.internal",
) {
  const inline = dataImage.exec(url);
  if (inline) {
    const [, mimeType = "", data = ""] = inline;
    if (data.length > INLINE_IMAGE_LIMIT) throw new Error("Inline image exceeds 20 MiB");
    return { type: "image" as const, mimeType, data: data.replace(/[\r\n]/g, "") };
  }
  const response = await fetch(
    `${endpoint.replace(/\/$/, "")}/image?url=${encodeURIComponent(url)}`,
    { signal },
  );
  if (!response.ok) throw new Error("Assigned image could not be loaded");
  const mimeType = z
    .string()
    .regex(/^image\/[a-zA-Z0-9.+-]+$/)
    .parse(response.headers.get("content-type")?.split(";")[0]);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 1_000_000) throw new Error("Image exceeds 1 MB");
  return { type: "image" as const, mimeType, data: Buffer.from(bytes).toString("base64") };
}
