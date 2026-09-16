import { join, resolve } from "node:path";

import { packageManagerExec, run, type Runner } from "./exec.js";
import { readIfExists } from "./fs.js";
import { parseJsonc } from "./jsonc.js";
import { CliError, Plan } from "./plan.js";
import { locateProject, type Project, type WranglerConfig } from "./project.js";
import { parseDevVars } from "./steps/dev-vars.js";
import { MINIMUM_TOKEN_LENGTH, randomToken } from "./token.js";
import {
  clackPrompter,
  clackReporter,
  defaultPrompter,
  interactive,
  plainReporter,
  type Prompter,
  type Reporter,
} from "./ui.js";

export interface SetupOptions {
  dir: string;
  dryRun: boolean;
  /** Read secret values from the environment instead of prompting. */
  fromEnv: boolean;
  skipSecrets: boolean;
  skipBuckets: boolean;
  prompter?: Prompter;
  reporter?: Reporter;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
}

const PROVIDER_SECRETS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MODEL_API_KEY"];
const R2_SECRETS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
const ACCOUNT_SECRET = "CLOUDFLARE_R2_ACCOUNT_ID";
const R2_TOKEN_HELP =
  "R2 → Manage R2 API Tokens in the Cloudflare dashboard: create a token with Object Read & Write on the workspaces bucket.";

interface Wrangler {
  (args: readonly string[], input?: string): ReturnType<Runner>;
  describe(args: readonly string[]): string;
}
function wranglerFor(project: Project, runner: Runner): Wrangler {
  const exec = packageManagerExec(project.packageManager);
  // wrangler runs with the project as cwd, so the configuration is named relative to it.
  const configArgs = ["--config", project.configPath.slice(project.root.length + 1)];
  const call = ((args, input) =>
    runner(exec[0] ?? "npx", [...exec.slice(1), "wrangler", ...args, ...configArgs], {
      cwd: project.root,
      input,
    })) as Wrangler;
  call.describe = (args) => [...exec, "wrangler", ...args, ...configArgs].join(" ");
  return call;
}

/** Creates the R2 buckets the configuration names; an existing bucket is a skip. */
export function ensureBuckets(
  config: WranglerConfig,
  wrangler: Wrangler,
  plan: Plan,
  dryRun: boolean,
): void {
  for (const bucket of config.r2_buckets ?? []) {
    if (!bucket.bucket_name) continue;
    const args = ["r2", "bucket", "create", bucket.bucket_name];
    if (dryRun) {
      plan.add({
        status: "created",
        file: `r2 bucket ${bucket.bucket_name}`,
        note: `Would run ${wrangler.describe(args)}`,
      });
      continue;
    }
    const result = wrangler(args);
    const output = result.stdout + result.stderr;
    if (result.ok) plan.add({ status: "created", file: `r2 bucket ${bucket.bucket_name}` });
    else if (/already exists/i.test(output))
      plan.add({ status: "skipped", file: `r2 bucket ${bucket.bucket_name}` });
    else throw new CliError(`Creating bucket ${bucket.bucket_name} failed:\n${output.trim()}`);
  }
}

/** The 32-hex account ids `wrangler whoami` prints. */
export function accountIds(output: string): string[] {
  return [...new Set(output.match(/\b[0-9a-f]{32}\b/g) ?? [])];
}

async function resolveAccountId(
  wrangler: Wrangler,
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const fromEnv = env.CLOUDFLARE_R2_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (fromEnv) return fromEnv;
  const whoami = wrangler(["whoami"]);
  const ids = accountIds(whoami.stdout);
  if (ids.length === 1 && ids[0]) return ids[0];
  if (ids.length > 1)
    return prompter.select(
      "Cloudflare account",
      ids.map((id) => ({ value: id, label: id })),
      ids[0] ?? "",
    );
  return prompter.text("Cloudflare account id (dashboard → Workers & Pages → Account details)", "");
}

function secretNames(root: string): string[] {
  const devVars = parseDevVars(readIfExists(join(root, ".dev.vars")) ?? "");
  const provider = PROVIDER_SECRETS.filter((name) => devVars.has(name));
  return ["API_TOKEN", ...provider, ...R2_SECRETS, ACCOUNT_SECRET];
}

async function collectSecrets(
  names: readonly string[],
  root: string,
  wrangler: Wrangler,
  prompter: Prompter,
  options: SetupOptions,
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  const devVars = parseDevVars(readIfExists(join(root, ".dev.vars")) ?? "");
  const values: Record<string, string> = {};
  for (const name of names) {
    if (options.fromEnv) {
      const value = env[name];
      if (!value) throw new CliError(`--from-env: ${name} is not set in the environment`);
      values[name] = value;
      continue;
    }
    values[name] = await promptSecret(name, devVars.get(name), wrangler, prompter, env);
  }
  return values;
}

async function promptSecret(
  name: string,
  local: string | undefined,
  wrangler: Wrangler,
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (name === ACCOUNT_SECRET) return resolveAccountId(wrangler, prompter, env);
  if (name === "API_TOKEN") {
    if (
      local &&
      local.length >= MINIMUM_TOKEN_LENGTH &&
      (await prompter.confirm("Use the API_TOKEN from .dev.vars in production?", true))
    )
      return local;
    if (await prompter.confirm("Generate a new API_TOKEN? (No = type one)", true))
      return randomToken();
  }
  if (name === "R2_ACCESS_KEY_ID") console.log(R2_TOKEN_HELP);
  const value = await prompter.password(`${name}`);
  if (name === "API_TOKEN" && value.length < MINIMUM_TOKEN_LENGTH)
    throw new CliError(`API_TOKEN must be at least ${MINIMUM_TOKEN_LENGTH} characters`);
  return value;
}

export async function runSetup(options: SetupOptions): Promise<Plan> {
  const root = resolve(options.dir);
  const project = locateProject(root);
  if (project.mode === "standalone")
    throw new CliError("No Wrangler configuration here; run create-cf-open-agents-api init first.");
  const text = readIfExists(project.configPath) ?? "";
  const config = parseJsonc<WranglerConfig>(text, project.configPath);
  const prompter =
    options.prompter ?? (options.fromEnv || !interactive() ? defaultPrompter() : clackPrompter());
  const reporter = options.reporter ?? (interactive() ? clackReporter() : plainReporter());
  const wrangler = wranglerFor(project, options.runner ?? run);
  const plan = new Plan();
  reporter.intro(
    `Production setup for ${config.name ?? project.root}${options.dryRun ? " (dry run)" : ""}`,
  );
  if (!options.skipBuckets) ensureBuckets(config, wrangler, plan, options.dryRun);
  if (!options.skipSecrets) {
    const names = secretNames(root);
    if (options.dryRun)
      plan.add({
        status: "updated",
        file: `secrets ${names.join(", ")}`,
        note: `Would run ${wrangler.describe(["secret", "bulk"])} with the values on stdin`,
      });
    else {
      const values = await collectSecrets(names, root, wrangler, prompter, options);
      const result = wrangler(["secret", "bulk"], JSON.stringify(values));
      if (!result.ok)
        throw new CliError(
          `wrangler secret bulk failed:\n${(result.stdout + result.stderr).trim()}`,
        );
      plan.add({ status: "updated", file: `secrets ${names.join(", ")}` });
    }
  }
  plan.note(
    "LOCAL_BACKUPS stays out of production: the Sandbox SDK then signs presigned R2 URLs with the R2 secrets.",
  );
  plan.note(
    `Deploy with ${wrangler.describe(["deploy"])}; the first deploy pushes both images and takes several minutes.`,
  );
  reporter.outro(plan.render(options.dryRun ? "Dry run: nothing was changed" : "Done"));
  return plan;
}
