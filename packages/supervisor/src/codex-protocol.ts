import { CONNECTION_FAILURE, type RuntimeCommand, type RuntimeEvent } from "cf-open-agents-api";
import { z } from "zod";

import type { TurnErrorCode } from "./lifecycle.js";

// --- App-server request and response shapes -------------------------------------------

export const threadResponse = z.object({ thread: z.object({ id: z.string() }) });
export const turnResponse = z.object({ turn: z.object({ id: z.string() }) });
export const toolCall = z.object({ callId: z.string(), tool: z.string(), arguments: z.json() });
/** EXPERIMENTAL `item/tool/requestUserInput` server request (ToolRequestUserInputParams). */
export const userInputRequest = z.object({
  itemId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z
        .array(z.object({ label: z.string(), description: z.string() }))
        .nullable()
        .optional(),
    }),
  ),
});
/** Codex error variants with one public code each; transport variants are handled apart. */
const CODEX_ERROR_CODES: ReadonlyMap<string, TurnErrorCode> = new Map([
  ["contextWindowExceeded", "context_length_exceeded"],
  ["sessionBudgetExceeded", "session_budget_exceeded"],
  ["usageLimitExceeded", "usage_limit_exceeded"],
  ["rateLimitExceeded", "rate_limit_exceeded"],
  ["serverOverloaded", "server_overloaded"],
  ["cyberPolicy", "cyber_policy"],
  ["misalignmentPolicyViolation", "cyber_policy"],
  ["internalServerError", "server_error"],
  ["unauthorized", "authentication_error"],
  ["badRequest", "invalid_request"],
  ["sandboxError", "sandbox_error"],
  ["activeTurnNotSteerable", "active_turn_not_steerable"],
]);
/**
 * Transport variants: Codex reports the upstream HTTP status it gave up on, and
 * that status is more informative than the wrapper (e.g. 429 after retries).
 */
const CONNECTION_VARIANTS = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
const variantDetail = z.object({ httpStatusCode: z.number().nullish() });
/** `codexErrorInfo` is a camelCase enum string or a single-key object such as `{ httpConnectionFailed: { httpStatusCode } }`. */
function errorVariant(info: unknown): { variant?: string; httpStatusCode?: number } {
  if (typeof info === "string") return { variant: info };
  if (!info || typeof info !== "object") return {};
  const [variant] = Object.keys(info);
  if (variant === undefined) return {};
  const detail = variantDetail.safeParse((info as Record<string, unknown>)[variant]);
  return {
    variant,
    httpStatusCode: detail.success ? (detail.data.httpStatusCode ?? undefined) : undefined,
  };
}
/**
 * Translate Codex's `TurnError.codexErrorInfo` to the public `SessionTurnError.code`
 * vocabulary. Codex 0.154.0 classifies most provider HTTP failures as `other` and
 * keeps the status and upstream body in the message, so unknown variants read the
 * message before falling back to `internal_error`.
 */
export function turnErrorCode(info: unknown, message = ""): TurnErrorCode {
  const { variant, httpStatusCode: status } = errorVariant(info);
  if (variant !== undefined && CONNECTION_VARIANTS.has(variant))
    return httpStatusCode(status) ?? "connection_failed";
  const known = variant === undefined ? undefined : CODEX_ERROR_CODES.get(variant);
  return known ?? messageErrorCode(message) ?? "internal_error";
}
function httpStatusCode(status: number | undefined): TurnErrorCode | undefined {
  if (status === undefined) return undefined;
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "resource_not_found";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 503 || status === 529) return "server_overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 422) return "invalid_request";
  return undefined;
}
/**
 * The exec-server is the sandbox's transport: Codex reports a WebSocket it could not
 * open or keep as `other` naming the server or the Worker's `sandbox.internal` host.
 */
const SANDBOX_TRANSPORT = /exec-server|sandbox\.internal/i;
/**
 * Codex's `other` errors keep the upstream wording. A sandbox transport failure is
 * the sandbox's own code; a message naming an HTTP status is an answer from the
 * upstream, so its status maps first, and the shared transport phrases (reqwest's
 * `error sending request`, the socket errors it wraps, a stream that ended before
 * the response did) decide only when the status maps to nothing.
 */
export function messageErrorCode(message: string): TurnErrorCode | undefined {
  if (/context_length_exceeded|context[ _]window|exceeds the context/i.test(message))
    return "context_length_exceeded";
  if (/insufficient_quota|usage_limit_reached|usage_not_included/i.test(message))
    return "usage_limit_exceeded";
  if (SANDBOX_TRANSPORT.test(message)) return "sandbox_error";
  const status = /\bstatus:?\s*(\d{3})\b/i.exec(message)?.[1];
  const byStatus = status ? httpStatusCode(Number(status)) : undefined;
  if (byStatus) return byStatus;
  return CONNECTION_FAILURE.test(message) ? "connection_failed" : undefined;
}
const tokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsage>;
export const completedItem = z.object({
  item: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("mcpToolCall"),
      id: z.string(),
      server: z.string(),
      tool: z.string(),
      status: z.string(),
      arguments: z.json(),
      result: z.json(),
      error: z.json(),
    }),
    z.object({
      type: z.literal("agentMessage"),
      id: z.string(),
      text: z.string(),
      phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
    }),
    z.object({
      type: z.literal("commandExecution"),
      id: z.string(),
      command: z.string(),
      aggregatedOutput: z.string().nullable().optional(),
      exitCode: z.number().nullable().optional(),
      cwd: z.string().nullable().optional(),
      durationMs: z.number().nullable().optional(),
      status: z.string().optional(),
    }),
  ]),
});
export const childStateSchema = z.object({
  parent: z.string(),
  name: z.string().nullable(),
  instructions: z.string().nullable(),
  openedAt: z.number(),
  closed: z.boolean(),
  active: z.boolean(),
  turnId: z.string().optional(),
});
export type ChildState = z.infer<typeof childStateSchema>;
export type CompletedItem = z.infer<typeof completedItem>["item"];
export const childId = (id: string) => `subagent_${id.replaceAll("-", "")}`;
export const childTurnId = (id: string) => `turn_${id.replaceAll("-", "")}`;

// --- App-server notification shapes -----------------------------------------------------

/** Where a notification comes from: the native thread it names and, for a child, its public scope. */
export interface Origin {
  readonly nativeThread?: string;
  readonly child?: ChildState;
  readonly scope: { subagentId?: string; turnId?: string };
}
export const originParams = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
});
export const threadStartedNotification = z.object({
  thread: z.object({
    id: z.string(),
    parentThreadId: z.string().nullable(),
    createdAt: z.number(),
    agentNickname: z.string().nullable().optional(),
  }),
});
export const childTurnSchema = z.object({
  turn: z.object({
    id: z.string(),
    status: z.string(),
    startedAt: z.number().nullable(),
    completedAt: z.number().nullable(),
  }),
});
export const rootTurnSchema = z.object({
  turn: z.object({
    status: z.string(),
    error: z
      .object({
        message: z.string(),
        codexErrorInfo: z.unknown().optional(),
        additionalDetails: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});
export const tokenUsageUpdate = z.object({
  turnId: z.string(),
  tokenUsage: z.object({ last: tokenUsage, total: tokenUsage }),
});
export const itemDeltaUpdate = z.object({ itemId: z.string(), delta: z.string() });
export const reasoningSummaryUpdate = z.object({
  itemId: z.string(),
  summaryIndex: z.number().int().nonnegative(),
  delta: z.string().optional(),
});
export const reasoningItem = z.object({
  item: z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: z.array(z.string()).default([]),
  }),
});
export const webSearchItem = z.object({
  item: z.object({
    type: z.literal("webSearch"),
    id: z.string(),
    query: z.string(),
    action: z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("search"),
          query: z.string().nullable().optional(),
          queries: z.array(z.string()).nullable().optional(),
        }),
        z.object({ type: z.literal("openPage"), url: z.string().nullable().optional() }),
        z.object({
          type: z.literal("findInPage"),
          url: z.string().nullable().optional(),
          pattern: z.string().nullable().optional(),
        }),
        z.object({ type: z.literal("other") }),
      ])
      .nullable()
      .optional(),
  }),
});
type WebSearchItem = z.infer<typeof webSearchItem>["item"];
export const collabItem = z.object({
  item: z.object({
    type: z.literal("collabAgentToolCall"),
    id: z.string(),
    tool: z.string(),
    status: z.string(),
    senderThreadId: z.string(),
    receiverThreadIds: z.array(z.string()),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
  }),
});
export type CollabItem = z.infer<typeof collabItem>["item"];
export const collaborationOperation = z.enum([
  "spawnAgent",
  "sendInput",
  "resumeAgent",
  "wait",
  "closeAgent",
  "sendMessage",
  "followupTask",
  "interruptAgent",
]);

function searchAction(
  action: WebSearchItem["action"],
): Extract<RuntimeEvent, { type: "web_search" }>["action"] {
  if (!action) return null;
  switch (action.type) {
    case "search":
      return { type: "search", query: action.query ?? null, queries: action.queries ?? null };
    case "openPage":
      return { type: "open_page", url: action.url ?? null };
    case "findInPage":
      return { type: "find_in_page", url: action.url ?? null, pattern: action.pattern ?? null };
    case "other":
      return { type: "other" };
  }
}
export const webSearchEvent = (
  item: WebSearchItem,
  status: "in_progress" | "completed",
  scope: Origin["scope"],
): RuntimeEvent => ({
  ...scope,
  type: "web_search",
  id: item.id,
  status,
  action: searchAction(item.action),
});
/** A running child turn is in progress; a finished one reads Codex's own status. */
export function childTurnStatus(
  active: boolean,
  status: string,
): "in_progress" | "completed" | "cancelled" | "failed" {
  if (active) return "in_progress";
  if (status === "completed") return "completed";
  return status === "interrupted" ? "cancelled" : "failed";
}
/** Codex reports a status for declined and failed commands; otherwise the exit code decides. */
export function commandStatus(
  item: Extract<CompletedItem, { type: "commandExecution" }>,
): "completed" | "failed" | "incomplete" {
  if (item.status === "completed") return "completed";
  if (item.status === "declined" || item.status === "failed") return "failed";
  if (item.exitCode === null || item.exitCode === undefined) return "incomplete";
  return item.exitCode === 0 ? "completed" : "failed";
}
/** A client tool result as Codex's `contentItems`. */
export const contentItems = (command: Extract<RuntimeCommand, { type: "tool_result" }>) =>
  typeof command.output === "string"
    ? [{ type: "inputText", text: command.output }]
    : command.output.map((part) =>
        part.type === "input_text"
          ? { type: "inputText", text: part.text }
          : { type: "inputImage", imageUrl: part.image_url },
      );
