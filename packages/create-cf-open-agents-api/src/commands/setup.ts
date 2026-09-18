import { define } from "gunshi";

import { runSetup } from "../setup.js";

export const setupCommand = define({
  name: "setup",
  description: "Production provisioning: create the R2 buckets and put the secrets with wrangler",
  args: {
    directory: {
      type: "positional",
      required: false,
      description: "Project directory (default: current directory)",
    },
    dir: { type: "string", description: "Project directory, as an option" },
    "dry-run": { type: "boolean", description: "Print the wrangler commands without running them" },
    "from-env": {
      type: "boolean",
      description: "Read secret values from environment variables instead of prompting",
    },
    "skip-secrets": { type: "boolean", description: "Do not put secrets" },
    "skip-buckets": { type: "boolean", description: "Do not create buckets" },
  },
  run: async (ctx) => {
    await runSetup({
      dir: ctx.values.dir ?? ctx.values.directory ?? process.cwd(),
      dryRun: Boolean(ctx.values["dry-run"]),
      fromEnv: Boolean(ctx.values["from-env"]),
      skipSecrets: Boolean(ctx.values["skip-secrets"]),
      skipBuckets: Boolean(ctx.values["skip-buckets"]),
    });
  },
});
