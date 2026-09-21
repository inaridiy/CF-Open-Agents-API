import { Effect } from "effect";

import { sha256Hex } from "../bytes.js";
import { io } from "../effect.js";
import {
  AssignmentConflict,
  CheckpointHarnessMismatch,
  HarnessUnknown,
  ImageLimitExceeded,
  Superseded,
} from "../errors.js";
import { HARNESSES, type HarnessName } from "../harnesses.js";
import type { Assignment } from "../persistence/harness-kinds.js";
import type { Execution, RuntimeCommand } from "../runtime.js";
import { workspaceTools } from "../workspace.js";

const IMAGE_DIGEST_LIMIT = 256;
const IMAGE_DATA_PREFIX = "data:";
export function remoteImageURLs(parts: readonly { type: string; image_url?: string }[]): string[] {
  return parts.flatMap((part) =>
    part.type === "input_image" && part.image_url && !part.image_url.startsWith(IMAGE_DATA_PREFIX)
      ? [part.image_url]
      : [],
  );
}

/** The durable execution identity moved on since `expected` was read. */
export const superseded = (
  current: Pick<Assignment, "turnId" | "generation">,
  expected: Pick<Assignment, "turnId" | "generation">,
) => current.turnId !== expected.turnId || current.generation !== expected.generation;
/** The bounded set of remote image URLs a turn may fetch, as digests; excess is an explicit error. */
export const imageDigests = (urls: readonly string[], existing: readonly string[]) =>
  Effect.gen(function* () {
    const digests = yield* io("assignment.images", () => Promise.all(urls.map(sha256Hex)));
    const merged = [...new Set([...existing, ...digests])];
    if (merged.length > IMAGE_DIGEST_LIMIT)
      return yield* new ImageLimitExceeded({ limit: IMAGE_DIGEST_LIMIT, scope: "turn" });
    return merged;
  });
/** Code may call client functions, workspace tools and tools of configured MCP servers only. */
export function permittedCodeTool(current: Assignment, name: string): boolean {
  if (!current.programmatic) return false;
  if (current.programmatic.tools.includes(name)) return true;
  return (current.mcp ?? []).some((tool) => name.startsWith(`mcp__${tool.server_label}__`));
}
/**
 * Whether the model proxy may forward a request naming `model` for this assignment:
 * the session's pinned model, or one of the tier names the preset listed. Claude Code
 * resolves a subagent's `haiku`, `sonnet` or `opus` alias through
 * `ANTHROPIC_DEFAULT_*_MODEL`, which the supervisor sets from `execution.tiers`, so the
 * request that reaches the proxy names the tier's gateway model.
 */
export function modelAllowed(
  assignment: Pick<Assignment, "model" | "tiers">,
  model: unknown,
): model is string {
  if (typeof model !== "string") return false;
  if (model === assignment.model) return true;
  return Object.values(assignment.tiers ?? {}).includes(model);
}

/** The harness a start names, once its checkpoint is known to belong to that harness revision. */
export const admittedHarness = (execution: Execution) =>
  Effect.gen(function* () {
    if (!Object.hasOwn(HARNESSES, execution.harness))
      return yield* new HarnessUnknown({ harness: execution.harness });
    const harness = execution.harness as HarnessName;
    if (
      execution.checkpoint &&
      (execution.checkpoint.driver !== harness ||
        execution.checkpoint.revision !== HARNESSES[harness].revision)
    )
      return yield* new CheckpointHarnessMismatch({
        harness: execution.checkpoint.driver,
        revision: execution.checkpoint.revision,
      });
    return harness;
  });
/**
 * How the current assignment receives a start: a stale execution is `Superseded`, a retry
 * of a dispatched turn is a no-op, another session's turn is an `AssignmentConflict`.
 */
export const startAdmission = (execution: Execution, previous: Assignment | undefined) =>
  Effect.gen(function* () {
    if (
      previous &&
      (execution.generation < previous.generation ||
        (execution.generation === previous.generation && execution.turnId !== previous.turnId))
    )
      return yield* new Superseded({
        turnId: execution.turnId,
        generation: execution.generation,
      });
    if (previous?.turnId === execution.turnId && previous.dispatched) return "dispatched" as const;
    if (previous && previous.sessionId !== execution.sessionId)
      return yield* new AssignmentConflict({ sessionId: previous.sessionId });
    return "new" as const;
  });
/** Codex drives hosted search itself; the assignment records the mode the agent configured. */
const webSearchMode = (execution: Execution): NonNullable<Assignment["webSearchMode"]> =>
  execution.agent.tools?.some((tool) => tool.type === "web_search")
    ? (execution.agent.tools.find((tool) => tool.type === "web_search")?.mode ?? "live")
    : "disabled";
/** Worker-authoritative names code may call: client functions plus, with a sandbox, workspace tools. */
function programmaticConfig(execution: Execution): Assignment["programmatic"] | undefined {
  const tools = execution.agent.tools;
  if (!tools?.some((tool) => tool.type === "programmatic_tool_calling" && tool.enabled !== false))
    return;
  return {
    tools: [
      ...tools.filter((tool) => tool.type === "function").map((tool) => tool.name),
      ...(execution.sandbox ? Object.keys(workspaceTools) : []),
    ],
    deadline: execution.deadline,
  };
}
/** Only a root turn with delegates may spawn children; they inherit this configuration. */
function delegationConfig(execution: Execution): Assignment["delegation"] | undefined {
  if (!execution.delegates?.length || execution.parent) return;
  return {
    delegates: execution.delegates,
    maxConcurrentSubagents: execution.maxConcurrentSubagents ?? 6,
    agent: execution.agent,
    deadline: execution.deadline,
    ...(execution.environmentId ? { environmentId: execution.environmentId } : {}),
  };
}
/** The assignment a start writes before dispatch; `digests` bounds the images the turn may fetch. */
export function buildAssignment(
  execution: Execution,
  harness: HarnessName,
  digests: string[],
): Assignment {
  const programmatic = programmaticConfig(execution);
  const delegation = delegationConfig(execution);
  return {
    sessionId: execution.sessionId,
    generation: execution.generation,
    turnId: execution.turnId,
    model: execution.model,
    ...(execution.tiers ? { tiers: execution.tiers } : {}),
    ...(harness === "codex" ? { webSearchMode: webSearchMode(execution) } : {}),
    harness,
    dispatched: false,
    sandbox: execution.sandbox,
    tenant: execution.tenant,
    vaultIds: execution.vaultIds,
    mcp: (execution.agent.tools ?? []).filter((tool) => tool.type === "mcp"),
    imageDigests: digests,
    ...(programmatic ? { programmatic } : {}),
    ...(delegation ? { delegation } : {}),
    ...(execution.parent ? { parent: execution.parent } : {}),
  };
}
type AgentTool = NonNullable<Execution["agent"]["tools"]>[number];
/**
 * Configured MCP servers reach the harness through the Worker's proxy; Codex keeps the
 * stdio and environment-origin servers it drives itself.
 */
function proxiedTool(tool: AgentTool, harness: HarnessName) {
  if (tool.type !== "mcp") return tool;
  if (
    harness === "codex" &&
    (tool.transport.type !== "http" || tool.connection_origin === "environment")
  )
    return tool;
  return {
    ...tool,
    transport: { type: "http", server_url: `http://mcp.internal/${tool.server_label}` },
    connection_origin: "service",
    credential_id: null,
    request_metadata: {},
  };
}
/** The supervisor job body: the execution with proxied tools, portable instructions and the checkpoint. */
export function jobBody(
  execution: Execution,
  assigned: Assignment,
  capabilityRoots: string[],
  portableInstructions: string,
  operationId: string,
  checkpoint: unknown,
): string {
  return JSON.stringify({
    execution: {
      ...execution,
      capabilityRoots,
      agent: {
        ...execution.agent,
        instructions: [execution.agent.instructions, portableInstructions]
          .filter(Boolean)
          .join("\n\n"),
        tools: [
          ...(execution.agent.tools ?? []).filter((tool) => tool.type !== "mcp"),
          ...(assigned.mcp ?? []),
        ].map((tool) => proxiedTool(tool, assigned.harness)),
      },
    },
    operationId,
    checkpoint,
  });
}

/** Image-bearing parts of a command, for the digest allow-list. */
export function commandParts(
  command: RuntimeCommand,
): readonly { type: string; image_url?: string }[] {
  if (command.type === "steer") return command.input.flatMap((message) => message.content);
  if (command.type === "tool_result" && Array.isArray(command.output)) return command.output;
  return [];
}
export function rejectionMessage(
  body: { code?: unknown; message?: unknown; error?: unknown },
  status: number,
): string {
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  return `Harness rejected control (${status})`;
}
