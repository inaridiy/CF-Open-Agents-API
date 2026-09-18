import { dirname, join, resolve } from "node:path";

import { collectAnswers, type InitAnswers, type InitPreferences } from "./answers.js";
import { installCommand, packageManagerExec, run, type Runner } from "./exec.js";
import { Files } from "./fs.js";
import { parseJsonc } from "./jsonc.js";
import { CliError, Plan } from "./plan.js";
import { locateProject, type Project, type WranglerConfig } from "./project.js";
import { ensureAgentsFile } from "./steps/agents-file.js";
import { ensureDevVars, ensureDevVarsExample } from "./steps/dev-vars.js";
import { ensureEntryExports } from "./steps/entry.js";
import { ensureGitignore } from "./steps/gitignore.js";
import { ensurePackageJson, type PackageJsonOptions, vendorScript } from "./steps/package-json.js";
import { ensurePnpmBuilds } from "./steps/pnpm-builds.js";
import { ensureStandaloneSkeleton } from "./steps/standalone.js";
import { ensureTsconfigExclude } from "./steps/tsconfig.js";
import { ensureVendor } from "./steps/vendor.js";
import { upsertWranglerConfig } from "./steps/wrangler.js";
import {
  type CompositionInput,
  describeSecret,
  PRESET_NAMES,
  providerPackages,
} from "./templates/agents.js";
import {
  clackPrompter,
  clackReporter,
  defaultPrompter,
  interactive,
  plainReporter,
  type Prompter,
  type Reporter,
} from "./ui.js";
import {
  CLI_NAME,
  CLI_VERSION,
  LIBRARY_NAME,
  PEER_VERSIONS,
  TOOLCHAIN_VERSIONS,
} from "./versions.js";

export interface InitOptions extends InitPreferences {
  dir: string;
  yes: boolean;
  force: boolean;
  dryRun: boolean;
  /** Path of the composition module; the default sits next to the Wrangler entry. */
  agentsFile?: string;
  /** Pre-publication: a packed library tarball or package directory for a `file:` dependency. */
  library?: string;
  cliPackage?: string;
  ref?: string;
  source?: string;
  prompter?: Prompter;
  reporter?: Reporter;
  runner?: Runner;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  today?: string;
  token?: () => string;
}

export interface InitResult {
  project: Project;
  answers: InitAnswers;
  plan: Plan;
  agentsPath: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const fileDependency = (path: string | undefined, fallback: string) =>
  path ? `file:${resolve(path)}` : fallback;

function choosePrompter(options: InitOptions): Prompter {
  if (options.prompter) return options.prompter;
  if (options.yes) return defaultPrompter();
  if (!interactive()) throw new CliError("Not a terminal; pass --yes to accept the defaults.");
  return clackPrompter();
}
const chooseReporter = (options: InitOptions): Reporter =>
  options.reporter ?? (interactive() && !options.yes ? clackReporter() : plainReporter());

export async function runInit(options: InitOptions): Promise<InitResult> {
  const root = resolve(options.dir);
  const project = locateProject(root, (options.env ?? process.env).npm_config_user_agent);
  const prompter = choosePrompter(options);
  const reporter = chooseReporter(options);
  const files = new Files(root, options.dryRun);
  reporter.intro(`${CLI_NAME} ${CLI_VERSION}${options.dryRun ? " (dry run)" : ""}`);
  await confirmNewProject(project, prompter);
  const configName =
    project.mode === "retrofit" ? readConfig(files, project).config.name : undefined;
  const answers = await collectAnswers(project, configName, options, prompter);
  const plan = new Plan();
  if (project.mode === "standalone")
    for (const result of ensureStandaloneSkeleton({
      files,
      name: answers.name,
      publicRoute: answers.publicRoute,
      today: options.today ?? today(),
    }))
      plan.add(result);
  plan.add(await vendor(options, root, reporter));
  const config = readConfig(files, project).config;
  const entryPath = resolve(root, config.main ?? "src/index.ts");
  const inEntry = compositionInEntry(files, project, entryPath);
  configureWrangler(files, project, answers, options, plan, !inEntry);
  const { agentsPath, composition } = compose(files, entryPath, inEntry, answers, options, plan);
  const secret = describeSecret(composition);
  plan.add(ensureDevVars({ files, secret, token: options.token }));
  plan.add(ensureDevVarsExample({ files, secret }));
  plan.add(ensureGitignore(files));
  plan.add(ensurePnpmBuilds(files, project.packageManager));
  plan.add(ensurePackageJson(manifestChanges(files, project, composition, options)));
  if (project.mode === "retrofit") plan.add(ensureTsconfigExclude(files));
  if (answers.install && !options.dryRun) await install(project, reporter, options.runner ?? run);
  reporter.note(nextSteps(project, answers, agentsPath), "Next steps");
  reporter.plan(plan, options.dryRun ? "Dry run: nothing was written" : "Done");
  return { project, answers, plan, agentsPath };
}

async function confirmNewProject(project: Project, prompter: Prompter): Promise<void> {
  if (project.mode === "retrofit") return;
  const create = await prompter.confirm(
    `No Wrangler configuration in ${project.root}. Create a new Workers project here?`,
    true,
  );
  if (!create)
    throw new CliError("Nothing to do: run inside a Workers project or let the CLI create one.");
}

/** A new project composes in its entry; so does a project this CLI created earlier. */
function compositionInEntry(files: Files, project: Project, entryPath: string): boolean {
  if (project.mode === "standalone") return true;
  return /defineAgentWorker[<(]/.test(files.read(entryPath) ?? "");
}

function configureWrangler(
  files: Files,
  project: Project,
  answers: InitAnswers,
  options: InitOptions,
  plan: Plan,
  agentsBinding: boolean,
): void {
  const { text } = readConfig(files, project);
  const outcome = upsertWranglerConfig(
    text,
    {
      name: answers.name,
      agentsBinding,
      workersAi: answers.workersAi || answers.provider === "workers-ai",
      codeLoader: answers.codeLoader,
      force: options.force,
    },
    project.configPath.slice(project.root.length + 1),
  );
  plan.add(files.write(project.configPath, outcome.text));
  for (const note of outcome.notes) plan.note(note);
}

function compose(
  files: Files,
  entryPath: string,
  inEntry: boolean,
  answers: InitAnswers,
  options: InitOptions,
  plan: Plan,
): { agentsPath: string; composition: CompositionInput } {
  const agentsPath = inEntry
    ? entryPath
    : resolve(files.root, options.agentsFile ?? join(dirname(entryPath), "agents.ts"));
  const composition: CompositionInput = {
    provider: answers.provider,
    harnesses: answers.harnesses,
    workersAi: answers.workersAi,
    baseURL: answers.baseURL,
    model: answers.model,
    standalone: inEntry,
  };
  plan.add(ensureAgentsFile(files, agentsPath, composition, options.force));
  if (!inEntry) plan.add(ensureEntryExports(files, entryPath, agentsPath));
  return { agentsPath, composition };
}

function manifestChanges(
  files: Files,
  project: Project,
  composition: CompositionInput,
  options: InitOptions,
): PackageJsonOptions {
  return {
    files,
    force: options.force,
    dependencies: {
      [LIBRARY_NAME]: fileDependency(options.library, CLI_VERSION),
      ...PEER_VERSIONS,
      ...providerPackages(composition),
    },
    devDependencies: {
      [CLI_NAME]: fileDependency(options.cliPackage, CLI_VERSION),
      ...(project.mode === "standalone" ? TOOLCHAIN_VERSIONS : {}),
    },
    scripts: { postinstall: vendorScript },
  };
}

function vendor(options: InitOptions, root: string, reporter: Reporter) {
  return reporter.spin(
    "Fetching the Docker image snapshot",
    () =>
      ensureVendor({
        root,
        version: CLI_VERSION,
        ref: options.ref,
        source: options.source,
        force: options.force,
        dryRun: options.dryRun,
        fetch: options.fetch,
        runner: options.runner,
        env: options.env,
      }),
    (result) => `Image snapshot ${result.status}`,
  );
}

export function readConfig(
  files: Files,
  project: Project,
): { text: string; config: WranglerConfig } {
  const text = files.read(project.configPath);
  if (text === undefined) throw new CliError(`${project.configPath} is missing`);
  return { text, config: parseJsonc<WranglerConfig>(text, project.configPath) };
}

async function install(project: Project, reporter: Reporter, runner: Runner): Promise<void> {
  const [command = "npm", ...args] = installCommand(project.packageManager).split(" ");
  const result = await reporter.spin(
    `Running ${installCommand(project.packageManager)}`,
    () => Promise.resolve(runner(command, args, { cwd: project.root })),
    (outcome) => (outcome.ok ? "Dependencies installed" : "Install failed"),
  );
  if (!result.ok)
    throw new CliError(
      `${installCommand(project.packageManager)} failed:\n${result.stderr.trim()}`,
    );
}

function firstPreset(answers: InitAnswers): string {
  if (answers.workersAi) return "workers";
  return PRESET_NAMES[answers.harnesses[0] ?? "codex"];
}

function nextSteps(project: Project, answers: InitAnswers, agentsPath: string): string {
  const exec = packageManagerExec(project.packageManager).join(" ");
  const composition = agentsPath.slice(project.root.length + 1);
  const dev =
    project.mode === "standalone"
      ? `${exec} wrangler dev`
      : "your dev server (vite dev or wrangler dev)";
  const use =
    project.mode === "retrofit"
      ? `Forward the API from your Worker: app.all("/v1/*", (c) => c.env.AGENTS.fetch(c.req.raw)) with AGENTS: Fetcher & AgentRPC.`
      : `curl -X POST http://localhost:8787/v1/agents/sessions -H "Authorization: Bearer <API_TOKEN from .dev.vars>" -H "Content-Type: application/json" -H "Idempotency-Key: first" -d '{"agent":{"model":"${firstPreset(answers)}"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/hello.txt"}'`;
  return [
    `1. ${installCommand(project.packageManager)}  (postinstall keeps the image snapshot current)`,
    `2. ${exec} wrangler login  (the AI binding and deployments need your account)`,
    `3. Start Docker, then ${dev}; the first image build takes several minutes.`,
    `4. ${use}`,
    `5. Presets and models live in ${composition}; the API token and provider key in .dev.vars.`,
    `6. Production: ${CLI_NAME} setup (R2 buckets and secrets), then ${exec} wrangler deploy.`,
  ].join("\n");
}
