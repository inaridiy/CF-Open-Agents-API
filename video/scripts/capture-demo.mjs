import { writeFile, mkdir } from "node:fs/promises";

import { z } from "zod";

import { browser, navigate, capture } from "./cdp.mjs";

const base = process.env.PROMO_DEMO_URL ?? "http://127.0.0.1:8787";
const prompt =
  "Build a polished, minimal tic-tac-toe game as one self-contained HTML file at /workspace/outputs/tic-tac-toe.html. Use an off-white background, blue X, dark O, system fonts, a clear turn indicator, win/draw detection, and a New game button. Two local players. No dependencies, no external resources. Use English for all UI and your short final response.";
const b = await browser();
try {
  await navigate(b, base);
  // Presentation-only translation of the existing demo's one Japanese help sentence.
  await b.evaluate(
    `document.documentElement.lang='en'; document.querySelector('main > p').textContent='Describe what you want built. An agent builds it in a sandbox and returns a zip.'; document.querySelector('textarea').value=${JSON.stringify(prompt)};document.querySelector('select').value='coding';document.querySelector('input[type=checkbox]').checked=false;true`,
  );
  await capture(b, "home");
  await b.evaluate(`document.querySelector('button[type=submit]').click();true`);
  let url = "";
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 300));
    url = z.string().parse(await b.evaluate("location.href"));
    if (url.includes("/jobs/")) break;
  }
  if (!url.includes("/jobs/")) throw new Error("Job creation did not navigate");
  console.log("Created demo job", url);
  await mkdir("out/capture", { recursive: true });
  await writeFile(
    "out/capture/session.json",
    JSON.stringify(
      {
        url,
        prompt,
        preset: "coding",
        runtime: "Codex",
        provider: "Workers AI",
        model: "@cf/zai-org/glm-4.7-flash",
        source: "/home/inaridiy/open-agents-api-test",
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  let completed = false;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const state = z
      .object({ text: z.string(), status: z.string().optional(), zip: z.string().optional() })
      .parse(
        await b.evaluate(
          `({text:document.body.innerText,status:document.querySelector('.status')?.innerText,zip:document.querySelector('a[href$="/zip"]')?.href})`,
        ),
      );
    if ([0, 2, 5, 10, 18, 28, 45].includes(i)) {
      await capture(b, `job-${i}`);
      console.log("Captured", i, state.status);
    }
    if (i === 5) {
      await capture(b, "reconnect-before");
      await navigate(b, url);
      await capture(b, "reconnect-after");
      console.log("Reloaded same session mid-run");
    }
    if (state.zip) {
      await capture(b, "job-done");
      await writeFile("out/capture/transcript.txt", state.text);
      const response = await fetch(state.zip);
      if (!response.ok) throw new Error("ZIP download failed");
      await writeFile("out/capture/deliverable.zip", Buffer.from(await response.arrayBuffer()));
      await navigate(b, url);
      await capture(b, "job-reloaded");
      completed = true;
      console.log("Completed and downloaded real artifact");
      break;
    }
    if (state.status?.includes("failed"))
      throw new Error("Runtime failed: " + state.text.slice(-1000));
  }
  if (!completed) throw new Error("Demo did not complete within ten minutes");
} finally {
  b.close();
}
