import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";
const assets = z
  .array(z.object({ path: z.string(), url: z.string().url(), sha256: z.string() }))
  .parse(JSON.parse(await readFile(new URL("../assets.json", import.meta.url), "utf8")));
for (const asset of assets) {
  const dest = new URL("../public/" + asset.path, import.meta.url);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`${asset.path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error(`${asset.path}: upstream changed; inspect before replacing`);
  await mkdir(dirname(dest.pathname), { recursive: true });
  await writeFile(dest, bytes);
  console.log(asset.path);
}
