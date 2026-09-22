import type { ISandbox } from "@cloudflare/sandbox";
import { Context, Effect } from "effect";

import type { CatalogObject } from "../catalog.js";
import type { EnvironmentWorkspace } from "../container-environments.js";
import type { HarnessContainer } from "../containers.js";
import type { HarnessRepository, HarnessTx } from "../persistence/harness-tx.js";
import type { Sync } from "../persistence/repo.js";
import type { Execution } from "../runtime.js";
import type { SandboxContainer } from "./sandbox.js";

export interface ContainerBindings {
  HARNESS: DurableObjectNamespace<HarnessContainer>;
  SANDBOX: DurableObjectNamespace<SandboxContainer>;
  CHECKPOINTS: R2Bucket;
  BACKUP_BUCKET: R2Bucket;
  MODEL_GATEWAY: Fetcher;
  CODE_LOADER?: WorkerLoader;
  /** Optional trusted service that sends configured service-origin MCP requests. */
  MCP?: Fetcher;
  LOCAL_BACKUPS?: string;
  /** Read by `@cloudflare/sandbox` to sign backup URLs; unset, only `LOCAL_BACKUPS` works. */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_R2_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  CATALOG: DurableObjectNamespace<CatalogObject>;
}

/** The two services a HarnessDO program needs; both are built once per object. */
export class HarnessRepo extends Context.Tag("agent-api/HarnessRepo")<
  HarnessRepo,
  HarnessRepository
>() {}
export class HarnessBindings extends Context.Tag("agent-api/HarnessBindings")<
  HarnessBindings,
  ContainerBindings
>() {}
export type HarnessServices = HarnessRepo | HarnessBindings;
export const read = <A>(f: (tx: HarnessTx) => Sync<A>) =>
  Effect.flatMap(HarnessRepo, (repo) => repo.read(f));
export const write = <A>(f: (tx: HarnessTx) => Sync<A>) =>
  Effect.flatMap(HarnessRepo, (repo) => repo.transaction(f));
export const assignment = read((tx) => tx.requireAssignment());

/**
 * What the programs in this directory need from the object that runs them: its bindings,
 * the synchronous row view for callbacks the runtime invokes outside a fiber, the
 * environment workspace, the workspace permit, and the Container methods they call.
 * `HarnessContainer` builds one over itself, so the deployment's `prepareSandbox`
 * override is honored.
 */
export interface HarnessHost {
  readonly env: ContainerBindings;
  readonly tx: HarnessTx;
  readonly environment: EnvironmentWorkspace;
  /** Serializes workspace operations against sandbox restores and uploads. */
  readonly workspace: Effect.Semaphore;
  /** Running programmatic tool executions, aborted by a newer start, a cancel or a stop. */
  readonly codeExecutions: Set<AbortController>;
  containerFetch(request: Request | string, init?: RequestInit): Promise<Response>;
  child(subagentId: string): DurableObjectStub<HarnessContainer>;
  abortCodeExecutions(): void;
  prepareSandbox(sandbox: ISandbox, execution: Execution): Promise<void>;
}
