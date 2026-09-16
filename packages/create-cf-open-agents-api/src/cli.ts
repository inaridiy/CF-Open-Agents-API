#!/usr/bin/env node
import { cli } from "gunshi";

import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { setupCommand } from "./commands/setup.js";
import { vendorCommand } from "./commands/vendor.js";
import { CliError } from "./plan.js";
import { CLI_NAME, CLI_VERSION } from "./versions.js";

async function main(): Promise<void> {
  await cli(process.argv.slice(2), initCommand, {
    name: CLI_NAME,
    version: CLI_VERSION,
    description: "Set up the CF-Open-Agents-API in a Cloudflare Workers project",
    subCommands: {
      init: initCommand,
      setup: setupCommand,
      doctor: doctorCommand,
      vendor: vendorCommand,
    },
  });
}

main().catch((error: unknown) => {
  if (error instanceof CliError) console.error(`✖ ${error.message}`);
  else console.error(error);
  process.exitCode = 1;
});
