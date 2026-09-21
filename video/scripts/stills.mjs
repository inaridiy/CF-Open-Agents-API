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
    : [
        30, 95, 140, 247, 340, 397, 450, 520, 558, 595, 650, 712, 744, 808, 936, 978, 1052, 1165,
        1230, 1340, 1430,
      ];
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
