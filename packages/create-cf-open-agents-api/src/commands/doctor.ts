import { define } from "gunshi";

import { renderReport, runDoctor } from "../doctor.js";

export const doctorCommand = define({
  name: "doctor",
  description:
    "Check the toolchain, the Wrangler configuration and the local secrets without changing anything",
  args: {
    directory: {
      type: "positional",
      required: false,
      description: "Project directory (default: current directory)",
    },
    dir: { type: "string", description: "Project directory, as an option" },
    json: { type: "boolean", description: "Print the report as JSON" },
    offline: { type: "boolean", description: "Skip the docker and wrangler checks" },
  },
  run: (ctx) => {
    const report = runDoctor({
      dir: ctx.values.dir ?? ctx.values.directory ?? process.cwd(),
      offline: Boolean(ctx.values.offline),
    });
    console.log(ctx.values.json ? JSON.stringify(report, null, 2) : renderReport(report));
    if (!report.ok) process.exitCode = 1;
  },
});
