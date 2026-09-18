import { copyFile } from "node:fs/promises";
import { join } from "node:path";

// pnpm runs prepack with the package directory as the working directory.
for (const name of ["LICENSE", "NOTICE", "CHANGELOG.md"])
  await copyFile(new URL(`../${name}`, import.meta.url), join(process.cwd(), name));
