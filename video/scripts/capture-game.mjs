import { writeFile } from "node:fs/promises";

import { z } from "zod";

import { browser, navigate } from "./cdp.mjs";
const b = await browser(9327);
try {
  await navigate(b, "http://127.0.0.1:8791/demo/tic-tac-toe.html");
  // Tight browser viewport presents the downloaded file legibly without changing it.
  await b.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });
  /** @param {string} name */
  const shot = async (name) => {
    const r = z
      .object({ data: z.string() })
      .parse(await b.send("Page.captureScreenshot", { format: "png" }));
    await writeFile(`public/textures/${name}.png`, Buffer.from(r.data, "base64"));
  };
  /** @param {number} i */
  const click = async (i) => {
    await b.evaluate(`document.querySelectorAll('.cell')[${i}].click();true`);
    await new Promise((r) => setTimeout(r, 250));
  };
  await shot("game-start");
  await click(0);
  await click(3);
  await click(1);
  await shot("game-play");
  await click(4);
  await click(2);
  await shot("game-win");
  const win = z.string().parse(await b.evaluate('document.querySelector(".status").innerText'));
  if (!/win/i.test(win)) throw new Error("Win detection failed: " + win);
  await b.evaluate('document.querySelector("button").click();true');
  const empty = await b.evaluate(
    '[...document.querySelectorAll(".cell")].every(e=>!e.textContent.trim())',
  );
  if (!empty) throw new Error("New game did not reset board");
  for (const i of [0, 1, 2, 4, 3, 5, 7, 6, 8]) await click(i);
  const draw = z.string().parse(await b.evaluate('document.querySelector(".status").innerText'));
  if (!/draw/i.test(draw)) throw new Error("Draw detection failed: " + draw);
  await writeFile(
    "out/capture/game-check.json",
    JSON.stringify(
      { win, reset: empty, draw, source: "Unmodified HTML downloaded from the recorded session" },
      null,
      2,
    ),
  );
  console.log("Game verified:", win, "reset", empty, draw);
} finally {
  b.close();
}
