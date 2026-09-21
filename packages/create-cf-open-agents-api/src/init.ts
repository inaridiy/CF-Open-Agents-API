import { dirname, join, resolve } from "node:path";

import { collectAnswers, type InitAnswers, type InitPreferences } from "./answers.js";
import {
  type CompositionRecord,
  ensureCompositionRecord,
  inferCompositionRecord,
  parseCompositionRecord,
  recordPath,
} from "./composition-record.js";
import { installCommand, packageManagerExec, run, type Runner } from "./exec.js";
import { display, Files } from "./fs.js";
import { parseJsonc } from "./jsonc.js";
import { CliError, Plan, type StepResult } from "./plan.js";
import { locateProject, type Project, type WranglerConfig } from "./project.js";
import { type AgentsFile, ensureAgentsFile } from "./steps/agents-file.js";
import { ensureDevVars, ensureDevVarsExample } from "./steps/dev-vars.js";
import { ensureEntryExports } from "./steps/entry.js";
import { ensureGitignore } from "./steps/gitignore.js";
import { ensurePackageJson, type PackageJsonOptions, vendorScript } from "./steps/package-json.js";
import { ensurePnpmBuilds } from "./steps/pnpm-builds.js";
import { detectRootlessDocker, ensureRootlessDev } from "./steps/rootless.js";
import { ensureStandaloneSkeleton } from "./steps/standalone.js";
import { ensureTsconfigExclude } from "./steps/tsconfig.js";
import { stageVendor, type StagedVendor } from "./steps/vendor.js";
import { upsertWranglerConfig } from "./steps/wrangler.js";
import {
  type CompositionInput,
  describeSecret,
  PRESET_NAMES,
  providerPackages,
} from "./templates/agents.js";
import { ROOTLESS_SCRIPT_NAME, rootlessScript } from "./templates/rootless.js";
import { ENTRY_FILES } from "./templates/standalone.js";
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
  COMPATIBILITY_DATE,
  DEMO_VERSIONS,
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
  token?: () => string;
}

export interface InitResult {
  project: Project;
  answers: InitAnswers;
  plan: Plan;
  agentsPath: string;
}

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
  const runner = options.runner ?? run;
  const files = new Files(root, options.dryRun);
  reporter.intro(`${CLI_NAME} ${CLI_VERSION}${options.dryRun ? " (dry run)" : ""}`);
  await confirmNewProject(project, prompter);
  const configName =
    project.mode === "retrofit" ? readConfig(files, project).config.name : undefined;
  // The docker call is skipped when a flag already decided.
  const rootlessDocker = options.rootless === undefined && detectRootlessDocker(runner);
  const recorded = existingComposition(files, project, options);
  const answers = await collectAnswers(project, configName, recall(options, recorded), prompter, {
    rootlessDocker,
  });
  const plan = new Plan();
  if (recorded)
    plan.note(
      `The existing composition decided the model provider (${recorded.provider}) and the runtimes (${recorded.harnesses.join(", ")}); --provider and --harnesses change them, --force rewrites the module.`,
    );
  const context: Run = { files, project, answers, recorded, options, plan };
  const staged = await vendor(options, root, reporter);
  const agentsPath = apply(context, staged);
  if (answers.install && !options.dryRun) await install(project, reporter, runner);
  reporter.note(nextSteps(project, answers, agentsPath), "Next steps");
  reporter.plan(plan, options.dryRun ? "Dry run: nothing was written" : "Done");
  return { project, answers, plan, agentsPath };
}

interface Run {
  files: Files;
  project: Project;
  answers: InitAnswers;
  recorded: CompositionRecord | undefined;
  options: InitOptions;
  plan: Plan;
}

/**
 * Computes every change against the overlay, then writes once. A conflict any step refuses
 * therefore leaves the project exactly as it was, snapshot included.
 */
function apply(context: Run, staged: StagedVendor): string {
  try {
    const agentsPath = planChanges(context, staged.result);
    context.files.flush();
    staged.commit?.();
    return agentsPath;
  } finally {
    staged.release();
  }
}

/**
 * Every step, in order, against the overlay; returns the path of the composition module.
 * The composition module is decided first because everything else follows the composition
 * the project ends up with, not the answers a fresh run would render: a kept module would
 * otherwise get bindings, packages and secrets from flags it does not implement.
 */
function planChanges(context: Run, snapshot: StepResult): string {
  const { files, project, answers, recorded, options, plan } = context;
  if (project.mode === "standalone")
    for (const result of ensureStandaloneSkeleton({
      files,
      name: answers.name,
      compatibilityDate: COMPATIBILITY_DATE,
      template: answers.template,
    }))
      plan.add(result);
  plan.add(snapshot);
  const config = readConfig(files, project).config;
  const entryPath = resolve(files.root, config.main ?? ENTRY_FILES.minimal);
  const inEntry = compositionInEntry(files, project, answers, entryPath);
  const agents = compose(files, entryPath, inEntry, answers, recorded, options);
  const composition = agents.composition;
  configureWrangler(files, project, answers, composition, options, plan, !inEntry);
  plan.add(agents.result);
  // The demo entry already re-exports the classes, so this is a skip there.
  if (!inEntry) plan.add(ensureEntryExports(files, entryPath, agents.agentsPath));
  if (agents.kept)
    for (const note of contradictions(files, agents.agentsPath, answers, composition))
      plan.note(note);
  if (composition) plan.add(ensureCompositionRecord(files, composition));
  const secret = composition && describeSecret(composition);
  plan.add(ensureDevVars({ files, secret, token: options.token }));
  plan.add(ensureDevVarsExample({ files, secret }));
  plan.add(ensureGitignore(files));
  plan.add(ensurePnpmBuilds(files, project.packageManager));
  plan.add(ensurePackageJson(manifestChanges(files, project, answers, composition, options)));
  if (answers.rootless)
    for (const result of ensureRootlessDev(files, options.force)) plan.add(result);
  if (project.mode === "retrofit") plan.add(ensureTsconfigExclude(files));
  return agents.agentsPath;
}

/**
 * What this run was told to build that the module it kept does not have. The module wins —
 * half-applying a flag would write a binding, a package or a secret for a composition the
 * Worker never loads — so the disagreement is reported instead.
 */
function contradictions(
  files: Files,
  agentsPath: string,
  answers: InitAnswers,
  composition: CompositionInput | undefined,
): string[] {
  if (!composition) return [];
  const asked: string[] = [];
  if (composition.provider !== answers.provider)
    asked.push(`provider ${answers.provider} (the module uses ${composition.provider})`);
  const harnesses = answers.harnesses.join(", ");
  const kept = composition.harnesses.join(", ");
  if (harnesses !== kept) asked.push(`runtimes ${harnesses} (the module has ${kept})`);
  if (answers.workersAi !== composition.workersAi)
    asked.push(
      answers.workersAi
        ? "a Workers AI preset (the module has none)"
        : "no Workers AI preset (the module has one)",
    );
  for (const [field, wanted, have] of [
    ["base URL", answers.baseURL, composition.baseURL],
    ["model", answers.model, composition.model],
  ] as const)
    if (wanted !== undefined && have !== undefined && wanted !== have)
      asked.push(`${field} ${wanted} (the module uses ${have})`);
  if (asked.length === 0) return [];
  return [
    `${display(files.root, agentsPath)} was kept, so it decides the composition: this run asked for ${asked.join("; ")}. Nothing was applied from those answers; --force regenerates the module instead.`,
  ];
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

/**
 * The minimal template composes in its entry, and so does a project this CLI created
 * from it earlier. The demo template and a retrofit keep the composition in `agents.ts`.
 */
function compositionInEntry(
  files: Files,
  project: Project,
  answers: InitAnswers,
  entryPath: string,
): boolean {
  if (project.mode === "standalone") return answers.template === "minimal";
  return /defineAgentWorker[<(]/.test(files.read(entryPath) ?? "");
}

/**
 * `workersAi` follows the composition in use, not the answers: the `AI` binding exists for
 * the presets the module declares, and an unattributed module gets none added on its say-so.
 * `codeLoader` is a binding the composition does not record, so the answer decides it.
 */
function configureWrangler(
  files: Files,
  project: Project,
  answers: InitAnswers,
  composition: CompositionInput | undefined,
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
      workersAi:
        composition !== undefined &&
        (composition.workersAi || composition.provider === "workers-ai"),
      codeLoader: answers.codeLoader,
      force: options.force,
    },
    display(project.root, project.configPath),
  );
  plan.add(files.write(project.configPath, outcome.text));
  for (const note of outcome.notes) plan.note(note);
}

/**
 * The composition a re-run must keep answering with: what an earlier run recorded, or, for a
 * project generated before the record existed, what the module on disk still says.
 */
function existingComposition(
  files: Files,
  project: Project,
  options: InitOptions,
): CompositionRecord | undefined {
  const fromRecord = parseCompositionRecord(files.read(recordPath(project.root)));
  if (fromRecord || project.mode === "standalone") return fromRecord;
  const entryPath = resolve(
    project.root,
    readConfig(files, project).config.main ?? ENTRY_FILES.minimal,
  );
  const agentsPath = resolve(
    project.root,
    options.agentsFile ?? join(dirname(entryPath), "agents.ts"),
  );
  return (
    inferCompositionRecord(files.read(agentsPath)) ?? inferCompositionRecord(files.read(entryPath))
  );
}

/** Flags win; otherwise the questions about the composition are answered by what it already is. */
function recall(options: InitOptions, recorded: CompositionRecord | undefined): InitPreferences {
  if (!recorded) return options;
  return {
    ...options,
    provider: options.provider ?? recorded.provider,
    harnesses: options.harnesses ?? recorded.harnesses,
    workersAi: options.workersAi ?? recorded.workersAi,
    baseURL: options.baseURL ?? recorded.baseURL,
    model: options.model ?? recorded.model,
  };
}

/** Writes or keeps the composition module; nothing is added to the plan, the caller orders it. */
function compose(
  files: Files,
  entryPath: string,
  inEntry: boolean,
  answers: InitAnswers,
  recorded: CompositionRecord | undefined,
  options: InitOptions,
): AgentsFile & { agentsPath: string } {
  const agentsPath = inEntry
    ? entryPath
    : resolve(files.root, options.agentsFile ?? join(dirname(entryPath), "agents.ts"));
  const agents = ensureAgentsFile(
    files,
    agentsPath,
    {
      provider: answers.provider,
      harnesses: answers.harnesses,
      workersAi: answers.workersAi,
      baseURL: answers.baseURL,
      model: answers.model,
      standalone: inEntry,
    },
    recorded,
    options.force,
  );
  return { ...agents, agentsPath };
}

function manifestChanges(
  files: Files,
  project: Project,
  answers: InitAnswers,
  composition: CompositionInput | undefined,
  options: InitOptions,
): PackageJsonOptions {
  const demo = project.mode === "standalone" && answers.template === "demo";
  return {
    files,
    force: options.force,
    dependencies: {
      [LIBRARY_NAME]: fileDependency(options.library, CLI_VERSION),
      ...PEER_VERSIONS,
      ...(composition ? providerPackages(composition) : {}),
      ...(demo ? DEMO_VERSIONS : {}),
    },
    devDependencies: {
      [CLI_NAME]: fileDependency(options.cliPackage, CLI_VERSION),
      ...(project.mode === "standalone" ? TOOLCHAIN_VERSIONS : {}),
    },
    scripts: {
      postinstall: vendorScript,
      ...(answers.rootless
        ? { [ROOTLESS_SCRIPT_NAME]: rootlessScript(project.packageManager) }
        : {}),
    },
  };
}

function vendor(options: InitOptions, root: string, reporter: Reporter): Promise<StagedVendor> {
  return reporter.spin(
    "Fetching the Docker image snapshot",
    () =>
      stageVendor({
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
    (staged) => `Image snapshot ${staged.result.status}`,
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
  const [command = "npm", ...args] = installCommand(project.packageManager);
  const described = installCommand(project.packageManager).join(" ");
  const result = await reporter.spin(
    `Running ${described}`,
    () => Promise.resolve(runner(command, args, { cwd: project.root })),
    (outcome) => (outcome.ok ? "Dependencies installed" : "Install failed"),
  );
  if (!result.ok) throw new CliError(`${described} failed:\n${result.stderr.trim()}`);
}

function firstPreset(answers: InitAnswers): string {
  if (answers.workersAi) return "workers";
  return PRESET_NAMES[answers.harnesses[0] ?? "codex"];
}

/** Step 4: how the freshly started project is exercised. */
function firstUse(project: Project, answers: InitAnswers): string {
  if (project.mode === "retrofit")
    return `Call the API from your Worker with the OpenAI client: new OpenAI({ baseURL: "https://agents.internal/v1", apiKey: env.API_TOKEN, fetch: (input, init) => env.AGENTS.fetch(new Request(input, init)) }).`;
  if (answers.template === "demo")
    return "Open http://localhost:8787, type what the agent should build and download the zip.";
  return `curl -X POST http://localhost:8787/v1/agents/sessions -H "Authorization: Bearer <API_TOKEN from .dev.vars>" -H "Content-Type: application/json" -H "Idempotency-Key: first" -d '{"agent":{"model":"${firstPreset(answers)}"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/hello.txt"}'`;
}

function nextSteps(project: Project, answers: InitAnswers, agentsPath: string): string {
  const exec = packageManagerExec(project.packageManager).join(" ");
  const composition = display(project.root, agentsPath);
  const runScript = (name: string) =>
    project.packageManager === "npm" ? `npm run ${name}` : `${project.packageManager} ${name}`;
  const devCommand =
    project.mode === "standalone"
      ? `${exec} wrangler dev`
      : "your dev server (vite dev or wrangler dev)";
  const dev = answers.rootless
    ? `${runScript(ROOTLESS_SCRIPT_NAME)} (rootless Docker; plain wrangler dev cannot complete a turn until Wrangler supports rootless engines)`
    : devCommand;
  const openDemo =
    project.mode === "standalone" && answers.template === "demo"
      ? " The deployed demo has no login: anyone with its workers.dev URL can create sessions on your account, so put Cloudflare Access in front of it or replace the page with your own auth (workers_dev: false in wrangler.jsonc keeps it reachable through Service Bindings only)."
      : "";
  return [
    `1. ${installCommand(project.packageManager).join(" ")}  (postinstall keeps the image snapshot current)`,
    `2. ${exec} wrangler login  (the AI binding and deployments need your account)`,
    `3. Start Docker, then ${dev}; the first image build takes several minutes.`,
    `4. ${firstUse(project, answers)}`,
    `5. Presets and models live in ${composition}; the API token and provider key in .dev.vars.`,
    `6. Production: ${CLI_NAME} setup (R2 buckets and secrets), then ${exec} wrangler deploy.${openDemo}`,
  ].join("\n");
}
