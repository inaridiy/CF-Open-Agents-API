import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Buffer } from "../../packages/supervisor/src/buffer.js";

/** Real HTTP boundary, including streaming bodies and disconnect cancellation. */
export async function serveFetch(fetch: (request: Request) => Promise<Response>) {
  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const abort = new AbortController();
    outgoing.on("close", () => abort.abort());
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Uint8Array);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const response = await fetch(
        new Request(`http://${incoming.headers.host}${incoming.url}`, {
          method: incoming.method,
          headers,
          signal: abort.signal,
          ...(!["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? { body: Buffer.concat(chunks) }
            : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body)
        for await (const chunk of response.body)
          if (!outgoing.write(chunk)) await once(outgoing, "drain");
      outgoing.end();
    } catch {
      if (outgoing.headersSent) outgoing.destroy();
      else {
        outgoing.writeHead(500);
        outgoing.end();
      }
    }
  };
  const server = createServer((incoming, outgoing) => {
    void handle(incoming, outgoing);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
