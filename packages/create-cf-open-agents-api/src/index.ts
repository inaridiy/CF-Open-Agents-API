/**
 * What the tests drive. The package ships an executable, not a library: nothing imports
 * `create-cf-open-agents-api`, so this is not a published entrypoint and every name here
 * exists because a test or another module needs it.
 */
export { type CompositionRecord, readCompositionRecord } from "./composition-record.js";
export { configChecks, devVarsCheck, runDoctor, snapshotCheck } from "./doctor.js";
export { Files } from "./fs.js";
export { type InitOptions, type InitResult, runInit } from "./init.js";
export { CliError } from "./plan.js";
export { workerNameFrom } from "./project.js";
export { accountIds, runSetup, type SetupOptions } from "./setup.js";
export { ensureDevVars, ensureDevVarsExample, parseDevVars } from "./steps/dev-vars.js";
export { ensurePnpmBuilds } from "./steps/pnpm-builds.js";
export { detectRootlessDocker } from "./steps/rootless.js";
export { ensureVendor, readVendorManifest } from "./steps/vendor.js";
export {
  type CompositionInput,
  describeSecret,
  HARNESSES,
  PROVIDERS,
  renderComposition,
} from "./templates/agents.js";
export { ROOTLESS_FILES, rootlessScript } from "./templates/rootless.js";
export type { Reporter } from "./ui.js";
export * as versions from "./versions.js";
