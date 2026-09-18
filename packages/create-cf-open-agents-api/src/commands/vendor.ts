import { define } from "gunshi";

import { plainReporter } from "../ui.js";
import { runVendor } from "../vendor.js";

export const vendorCommand = define({
  name: "vendor",
  description: "Refresh the .cf-open-agents-api image snapshot (also the postinstall hook)",
  args: {
    directory: {
      type: "positional",
      required: false,
      description: "Project directory (default: current directory)",
    },
    dir: { type: "string", description: "Project directory, as an option" },
    ref: { type: "string", description: "Git ref to snapshot (default: v<this version>)" },
    source: {
      type: "string",
      description: "Local repository checkout to snapshot instead of downloading",
    },
    force: {
      type: "boolean",
      short: "f",
      description: "Rebuild the snapshot even when it is current",
    },
    "dry-run": { type: "boolean", description: "Report without writing" },
  },
  run: async (ctx) => {
    const result = await runVendor({
      dir: ctx.values.dir ?? ctx.values.directory ?? process.cwd(),
      ref: ctx.values.ref,
      source: ctx.values.source,
      force: Boolean(ctx.values.force),
      dryRun: Boolean(ctx.values["dry-run"]),
    });
    plainReporter().info(`Image snapshot ${result.status}${result.note ? `: ${result.note}` : ""}`);
  },
});
