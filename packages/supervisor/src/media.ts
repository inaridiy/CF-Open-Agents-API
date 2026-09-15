import { Data } from "effect";
import { z } from "zod";

import { Buffer } from "./buffer.js";

/** The assigned media proxy could not serve the image. */
export class MediaUnavailable extends Data.TaggedError("MediaUnavailable")<{
  readonly status: number;
}> {
  override get message(): string {
    return "Assigned image could not be loaded";
  }
}
/** The image is not one a native runtime accepts; `reason` names the limit. */
export class InvalidImageData extends Data.TaggedError("InvalidImageData")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

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
    if (data.length > INLINE_IMAGE_LIMIT)
      throw new InvalidImageData({ reason: "Inline image exceeds 20 MiB" });
    return { type: "image" as const, mimeType, data: data.replace(/[\r\n]/g, "") };
  }
  const response = await fetch(
    `${endpoint.replace(/\/$/, "")}/image?url=${encodeURIComponent(url)}`,
    { signal },
  );
  if (!response.ok) throw new MediaUnavailable({ status: response.status });
  const mimeType = z
    .string()
    .regex(/^image\/[a-zA-Z0-9.+-]+$/)
    .safeParse(response.headers.get("content-type")?.split(";")[0]);
  if (!mimeType.success) throw new InvalidImageData({ reason: "Unsupported image content type" });
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 1_000_000) throw new InvalidImageData({ reason: "Image exceeds 1 MB" });
  return {
    type: "image" as const,
    mimeType: mimeType.data,
    data: Buffer.from(bytes).toString("base64"),
  };
}
