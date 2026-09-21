import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

import { z } from "zod";

export async function browser(port = 9326) {
  const chrome =
    process.env.PROMO_CHROME ??
    "/home/inaridiy/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=/tmp/cf-promo-chrome-${port}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const tabSchema = z.array(
    z.object({ type: z.string(), webSocketDebuggerUrl: z.string().optional() }),
  );
  let tabs = tabSchema.parse([]);
  for (let i = 0; i < 60; i++) {
    try {
      tabs = tabSchema.parse(await (await fetch(`http://127.0.0.1:${port}/json`)).json());
      if (tabs.length) break;
    } catch {
      // Chrome may still be starting its debugging endpoint.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const endpoint = tabs.find((t) => t.type === "page")?.webSocketDebuggerUrl;
  if (!endpoint) {
    proc.kill();
    throw new Error("Chrome debugging endpoint did not become ready");
  }
  const ws = new WebSocket(endpoint);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  /** @type {Map<number, {resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void}>} */
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const m = z
      .object({
        id: z.number().optional(),
        error: z.object({ message: z.string() }).optional(),
        result: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(JSON.parse(e.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result ?? {});
    }
  });
  /** @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 2,
    mobile: false,
  });
  return {
    send,
    proc,
    close: () => {
      ws.close();
      proc.kill();
    },
    /** @param {string} expression */
    evaluate: async (expression) => {
      const response = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails)
        throw new Error("Browser evaluation failed: " + JSON.stringify(response.exceptionDetails));
      return z.object({ result: z.object({ value: z.unknown() }) }).parse(response).result.value;
    },
  };
}

/** @param {Awaited<ReturnType<typeof browser>>} b
 * @param {string} url
 */
export async function navigate(b, url) {
  await b.send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await b.evaluate('document.readyState === "complete"')) break;
  }
  await b.evaluate("document.fonts.ready.then(() => true)");
  await new Promise((r) => setTimeout(r, 600));
}

/** @param {Awaited<ReturnType<typeof browser>>} b
 * @param {string} name
 */
export async function capture(b, name, root = "public/textures") {
  await mkdir(root, { recursive: true });
  const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
  const layout = z
    .object({
      url: z.string(),
      title: z.string(),
      width: z.number(),
      pageH: z.number(),
      elements: z.record(z.string(), boxSchema.nullable()),
    })
    .parse(
      await b.evaluate(
        `({url:location.href,title:document.title,width:innerWidth,pageH:Math.max(document.body.scrollHeight,innerHeight),elements:Object.fromEntries(['main','header','form','textarea','button','.status','.outputs','.final_answer','canvas'].map(s=>{const e=document.querySelector(s);if(!e)return[s,null];const r=e.getBoundingClientRect();return[s,{x:r.x,y:r.y+scrollY,w:r.width,h:r.height}]}))})`,
      ),
    );
  const shot = await b.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1920, height: layout.pageH, scale: 1 },
  });
  await writeFile(`${root}/${name}.png`, Buffer.from(z.string().parse(shot.data), "base64"));
  await writeFile(`${root}/${name}.layout.json`, JSON.stringify(layout, null, 2));
  for (const [selector, box] of Object.entries(layout.elements)) {
    if (!box || box.w <= 0 || box.h <= 0) continue;
    const img = await b.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.w, height: box.h, scale: 1 },
    });
    await writeFile(
      `${root}/${name}-${selector.replace(/[^a-z]/g, "")}.png`,
      Buffer.from(z.string().parse(img.data), "base64"),
    );
  }
  return layout;
}
