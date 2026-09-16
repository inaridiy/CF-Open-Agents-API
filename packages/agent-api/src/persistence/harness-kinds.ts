import type { McpToolConfig } from "../agent-tools.js";
import type { HarnessName } from "../harnesses.js";
import type { Checkpoint, Execution, RuntimeBatch } from "../runtime.js";
import { kind } from "./kind.js";

/** The turn a HarnessDO and its Container currently serve; the authorization boundary. */
export interface Assignment {
  sessionId: string;
  generation: number;
  turnId: string;
  model: string;
  webSearchMode?: "disabled" | "cached" | "live";
  harness: HarnessName;
  dispatched: boolean;
  revoked?: boolean;
  sandbox: boolean;
  tenant?: string;
  vaultIds?: readonly string[];
  mcp?: McpToolConfig[];
  /** Worker-authoritative code tool names; MCP tools are admitted by configured server label. */
  programmatic?: { tools: string[]; deadline: number };
  /** SHA-256 digests of image URLs this execution may fetch; the URLs themselves stay in SQLite items. */
  imageDigests?: string[];
  /** Present when this turn may delegate: the parent configuration children inherit. */
  delegation?: {
    delegates: NonNullable<Execution["delegates"]>;
    maxConcurrentSubagents: number;
    agent: Execution["agent"];
    deadline: number;
    environmentId?: string;
  };
  children?: string[];
  /** Set on a delegated child: it shares the parent's sandbox and is never checkpointed. */
  parent?: { turnId: string; subagentId: string };
}
/** Durable child bookkeeping in the parent HarnessDO; the terminal batch survives child destruction. */
export interface ChildRecord {
  execution: Execution;
  terminal?: RuntimeBatch;
}
/**
 * What the live Sandbox filesystem holds. A turn reuses the running sandbox when this
 * matches the workspace it must start from; otherwise it destroys and restores. The same
 * identity is written inside the container so a replaced container cannot be mistaken
 * for the one that was provisioned.
 */
export interface SandboxState {
  /** Backup id restored into or committed from the live filesystem; "" for a fresh workspace. */
  workspaceId: string;
  /** The deployment provisioning hook already ran for this workspace. */
  provisioned: boolean;
}
export type ArtifactManifest = NonNullable<Checkpoint["artifacts"]>;

/**
 * Every record kind a HarnessDO stores. The strings are the persisted table partition and
 * never change; singletons live under the id `current`.
 */
export const HarnessKinds = {
  assignment: kind<Assignment>("assignment"),
  sandbox: kind<SandboxState>("sandbox"),
  /** id = subagent id. */
  child: kind<ChildRecord>("child"),
  /** id = generation: the checkpoint committed for that turn. */
  checkpoint: kind<Checkpoint>("checkpoint"),
  /** id = generation: the artifact manifest published for that turn. */
  artifacts: kind<ArtifactManifest>("artifacts"),
} as const;
