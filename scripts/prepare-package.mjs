import { copyFile } from "node:fs/promises";

for (const name of ["LICENSE", "NOTICE", "CHANGELOG.md"])
  await copyFile(
    new URL(`../${name}`, import.meta.url),
    new URL(`../packages/agent-api/${name}`, import.meta.url),
  );
