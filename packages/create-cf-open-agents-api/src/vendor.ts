import { resolve } from "node:path";

import type { StepResult } from "./plan.js";
import { ensureVendor } from "./steps/vendor.js";
import { CLI_VERSION } from "./versions.js";

export interface VendorCommandOptions {
  dir: string;
  ref?: string;
  source?: string;
  force: boolean;
  dryRun: boolean;
}

export function runVendor(options: VendorCommandOptions): Promise<StepResult> {
  return ensureVendor({
    root: resolve(options.dir),
    version: CLI_VERSION,
    ref: options.ref,
    source: options.source,
    force: options.force,
    dryRun: options.dryRun,
  });
}
