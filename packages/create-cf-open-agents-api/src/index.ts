/** Programmatic surface: what the commands call and what the tests drive. */
export {
  collectAnswers,
  type Detected,
  type InitAnswers,
  type InitPreferences,
} from "./answers.js";
export { configChecks, devVarsCheck, renderReport, runDoctor, snapshotCheck } from "./doctor.js";
export { Files } from "./fs.js";
export { type InitOptions, type InitResult, runInit } from "./init.js";
export { CliError, Plan, type StepResult } from "./plan.js";
export { detectPackageManager, locateProject, workerNameFrom } from "./project.js";
export { accountIds, runSetup, type SetupOptions } from "./setup.js";
export { ensureDevVars, ensureDevVarsExample, parseDevVars } from "./steps/dev-vars.js";
export { agentsSpecifier } from "./steps/entry.js";
export { ensurePnpmBuilds, PNPM_BUILDS } from "./steps/pnpm-builds.js";
export {
  detectRootlessDocker,
  DOCKER_INFO_TIMEOUT_MS,
  dockerInfo,
  ensureRootlessDev,
  rootlessEngine,
} from "./steps/rootless.js";
export { ensureVendor, readVendorManifest, type VendorManifest } from "./steps/vendor.js";
export { upsertWranglerConfig, type WranglerInput } from "./steps/wrangler.js";
export {
  type CompositionInput,
  DEFAULT_MODELS,
  describeSecret,
  type Harness,
  HARNESSES,
  PRESET_NAMES,
  type Provider,
  PROVIDERS,
  providerPackages,
  renderComposition,
} from "./templates/agents.js";
export { DEMO_FILES, demoFile } from "./templates/demo.js";
export { ROOTLESS_FILES, ROOTLESS_SCRIPT_NAME, rootlessScript } from "./templates/rootless.js";
export { ENTRY_FILES, type Template, TEMPLATES } from "./templates/standalone.js";
export { defaultPrompter, plainReporter, type Prompter, type Reporter } from "./ui.js";
export { runVendor } from "./vendor.js";
export * as versions from "./versions.js";
