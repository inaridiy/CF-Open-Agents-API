import { define } from "gunshi";

import { parseHarnesses, parseProvider, parseTemplate } from "../answers.js";
import { runInit } from "../init.js";
import { HARNESSES, PROVIDERS } from "../templates/agents.js";
import { TEMPLATES } from "../templates/standalone.js";

export const initCommand = define({
  name: "init",
  description:
    "Add the Agents API to the Workers project in a directory, or create a new one there (default command)",
  args: {
    directory: {
      type: "positional",
      required: false,
      description: "Project directory (default: current directory)",
    },
    dir: { type: "string", description: "Project directory, as an option" },
    yes: { type: "boolean", short: "y", description: "Accept every default without prompting" },
    force: {
      type: "boolean",
      short: "f",
      description: "Rewrite files and entries that differ from the template",
    },
    "dry-run": { type: "boolean", description: "Report what would change without writing" },
    name: { type: "string", description: "Worker name when the configuration has none" },
    template: {
      type: "enum",
      choices: [...TEMPLATES],
      description: "New project: demo (Hono app around the API) or minimal (the API alone)",
    },
    provider: { type: "enum", choices: [...PROVIDERS], description: "Model provider" },
    "base-url": { type: "string", description: "openai-compatible: Chat Completions base URL" },
    model: { type: "string", description: "openai-compatible: model id" },
    harnesses: {
      type: "string",
      description: `Comma-separated runtimes (${HARNESSES.join(", ")})`,
    },
    "workers-ai": {
      type: "boolean",
      description: "Also add the Workers AI preset and the AI binding",
    },
    "code-loader": {
      type: "boolean",
      negatable: true,
      description:
        "Programmatic tool calling through Dynamic Workers (--no-code-loader disables it)",
    },
    rootless: {
      type: "boolean",
      negatable: true,
      description:
        "Add the dev:rootless script for rootless Docker (default: asked when detected; --no-rootless skips)",
    },
    "agents-file": {
      type: "string",
      description: "Path of the composition module (default: next to the entry)",
    },
    library: {
      type: "string",
      description:
        "Pre-publication: cf-open-agents-api tarball or directory for a file: dependency",
    },
    "cli-package": {
      type: "string",
      description: "Pre-publication: this CLI's tarball or directory for the postinstall hook",
    },
    ref: {
      type: "string",
      description: "Git ref of the image snapshot (default: v<this version>)",
    },
    source: {
      type: "string",
      description: "Local repository checkout to snapshot instead of downloading",
    },
    install: { type: "boolean", description: "Run the package manager install afterwards" },
  },
  run: async (ctx) => {
    const values = ctx.values;
    await runInit({
      dir: values.dir ?? values.directory ?? process.cwd(),
      yes: Boolean(values.yes),
      force: Boolean(values.force),
      dryRun: Boolean(values["dry-run"]),
      name: values.name,
      template: values.template === undefined ? undefined : parseTemplate(values.template),
      provider: values.provider === undefined ? undefined : parseProvider(values.provider),
      baseURL: values["base-url"],
      model: values.model,
      harnesses: values.harnesses === undefined ? undefined : parseHarnesses(values.harnesses),
      workersAi: values["workers-ai"],
      codeLoader: values["code-loader"],
      rootless: values.rootless,
      agentsFile: values["agents-file"],
      library: values.library,
      cliPackage: values["cli-package"],
      ref: values.ref,
      source: values.source,
      install: values.install,
    });
  },
});
