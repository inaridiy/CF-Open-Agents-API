import { z } from "zod";

const dataImage = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/;
/** Remote images pass through an assignment-scoped Worker proxy; native homes have no credentials. */
export async function imageContent(
  url: string,
  signal: AbortSignal,
  endpoint = "http://media.internal",
) {
  const inline = dataImage.exec(url);
  if (inline)
    return { type: "image" as const, mimeType: inline[1] ?? "image/png", data: inline[2] ?? "" };
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
