// `durable-machine` is a workspace package that is not published yet. The library ships
// it inside its own dist instead: this copies the built package to `dist/vendor/` and
// points the library's imports at that copy, so a consumer needs nothing from the
// registry. It runs after `tsc` with the package directory as the working directory.
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const dist = join(process.cwd(), "dist");
const vendor = join(dist, "vendor", "durable-machine");
const source = join(process.cwd(), "..", "durable-machine", "dist");
await cp(source, vendor, { recursive: true });

const entries = { "durable-machine": "index.js", "durable-machine/check": "check.js" };
async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path !== join(dist, "vendor")) yield* files(path);
    } else if (/\.(js|d\.ts)$/.test(entry.name)) yield path;
  }
}
let rewritten = 0;
for await (const file of files(dist)) {
  const text = await readFile(file, "utf8");
  const next = text.replace(/(["'])(durable-machine(?:\/check)?)\1/g, (match, quote, name) => {
    const target = relative(dirname(file), join(vendor, entries[name])).split("\\").join("/");
    return `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`;
  });
  if (next !== text) {
    await writeFile(file, next);
    rewritten += 1;
  }
}
if (rewritten === 0) throw new Error("No import of durable-machine was found to inline");
