import { createRequire } from "node:module";

import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve("@remotion/cli/package.json"));
const { bundle } = /** @type {{bundle: (options: {entryPoint: string}) => Promise<string>}} */ (
  cliRequire("@remotion/bundler")
);
const serveUrl = await bundle({ entryPoint: "src/index.ts" });
const browserExecutable =
  process.env.PROMO_CHROME ??
  "/home/inaridiy/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const browser = await openBrowser("chrome", {
  browserExecutable,
  chromiumOptions: { gl: "angle" },
});
try {
  const composition = await selectComposition({
    serveUrl,
    id: "Promo",
    puppeteerInstance: browser,
  });
  const frames = process.argv.slice(2).length
    ? process.argv.slice(2).map(Number)
    : [95, 200, 365, 540, 745, 1015, 1160, 1280, 1380, 1430, 1530, 1650, 1730, 1940, 2085];
  for (const frame of frames) {
    await renderStill({
      composition,
      serveUrl,
      output: `out/qa/f${frame}.png`,
      frame,
      puppeteerInstance: browser,
      imageFormat: "png",
    });
    console.log("frame", frame);
  }
} finally {
  await browser.close({ silent: true });
}
