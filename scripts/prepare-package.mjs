import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// pnpm runs prepack, and the setup CLI's build, with the package directory as the working
// directory.
const root = new URL("../", import.meta.url);
for (const name of ["LICENSE", "NOTICE", "CHANGELOG.md"])
  await copyFile(new URL(name, root), join(process.cwd(), name));

/**
 * The `demo` template the setup CLI ships is `examples/demo`, copied. The example is what
 * the repository deploys and what the documentation links to, so it is the original and
 * these are derived; `templates/demo/` is git-ignored and `pnpm test:cli` compares the
 * generated project with the example byte for byte, which fails if this copy did not run.
 * The project paths are the ones `src/templates/demo.ts` maps.
 */
const DEMO_TEMPLATE = {
  "index.tsx": "src/index.tsx",
  "ui.tsx": "src/ui.tsx",
  "README.md": "README.md",
};

const manifest = /** @type {{ name: string }} */ (
  JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"))
);
if (manifest.name === "create-cf-open-agents-api")
  for (const [name, source] of Object.entries(DEMO_TEMPLATE)) {
    const target = join(process.cwd(), "templates", "demo", name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL(`examples/demo/${source}`, root), target);
  }
