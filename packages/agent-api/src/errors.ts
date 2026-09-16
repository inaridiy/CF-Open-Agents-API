import { Data, Effect, Either, Schema } from "effect";

import { ApiError, isStatus, remoteApiError, type Status } from "./api-error.js";

/**
 * The failure vocabulary, one section per layer. Each class names the rule that failed
 * in that layer's own terms and carries the data a caller needs to react; none of them
 * knows an HTTP status. The projection at the end of this file is the only place that
 * maps a tag to `(status, code)`; it is a total table over the closed union, so a tag
 * without a mapping is a type error.
 *
 * A definite failure reports `ApiError`'s wire name through `name`, so a caller behind
 * an un-enveloped RPC hop still recovers its status and code (the platform reads `name`
 * and `message` as ordinary properties). `TransportFailure` and `StorageFailure` are
 * deliberately not named that way: a caller must never mistake them for a definite
 * answer. Classes whose values cross Durable Object RPC inside an envelope are
 * `Schema.TaggedError`, so they decode back into instances on the caller.
 */
const wired = <T>(cls: T): T => {
  Object.defineProperty((cls as { prototype: object }).prototype, "name", {
    get(this: DomainError) {
      return toApiError(this).name;
    },
    configurable: true,
  });
  return cls;
};
/** A definite failure that stays inside one object. */
const Definite = <Tag extends string>(tag: Tag) => wired(Data.TaggedError(tag));
/** A definite failure that may cross DO RPC as envelope data. */
const Enveloped =
  <Self = never>() =>
  <Tag extends string, Fields extends Schema.Struct.Fields>(tag: Tag, fields: Fields) =>
    wired(Schema.TaggedError<Self>()(tag, fields));

// --- Persistence ---------------------------------------------------------------------

export class RecordTooLarge extends Enveloped<RecordTooLarge>()("RecordTooLarge", {
  bytes: Schema.Number,
}) {
  override get message(): string {
    return "Serialized record exceeds 1,900,000 bytes";
  }
}
/** `RecordStore.require` found no row of `kind` under `id`. */
export class RecordNotFound extends Enveloped<RecordNotFound>()("RecordNotFound", {
  kind: Schema.String,
  id: Schema.String,
}) {
  override get message(): string {
    return `${this.kind} not found`;
  }
}
export class InvalidCursor extends Enveloped<InvalidCursor>()("InvalidCursor", {
  reason: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.reason ?? "Cursor does not belong to this collection";
  }
}
/** Thrown inside a fenced transaction after an unexpected failure; never a definite answer. */
export class StorageFailure extends Data.TaggedError("StorageFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation} failed`;
  }
}
export class SessionNotFound extends Enveloped<SessionNotFound>()("SessionNotFound", {}) {
  override get message(): string {
    return "Session not found";
  }
}
export class InvalidSessionState extends Enveloped<InvalidSessionState>()("InvalidSessionState", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
/** The durable execution identity moved on; the caller's work is void and stops silently. */
export class Superseded extends Definite("Superseded")<{
  readonly turnId: string;
  readonly generation: number;
}> {
  override get message(): string {
    return "Execution was superseded";
  }
}
/** A HarnessDO row read before any session was assigned to the container. */
export class ContainerUnassigned extends Definite("ContainerUnassigned")<{}> {
  override get message(): string {
    return "Container has no session assignment";
  }
}

// --- Domain: session lifecycle -------------------------------------------------------

export class IdempotencyConflict extends Enveloped<IdempotencyConflict>()("IdempotencyConflict", {
  subject: Schema.String,
  reason: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.reason ?? `Key was used with different ${this.subject}`;
  }
}
/** An indeterminate execution left the session failed; only a fork or a new session continues. */
export class SessionFailed extends Enveloped<SessionFailed>()("SessionFailed", {}) {
  override get message(): string {
    return "Fork or create a new session after an indeterminate execution";
  }
}
export class TurnCheckpointing extends Enveloped<TurnCheckpointing>()("TurnCheckpointing", {}) {
  override get message(): string {
    return "Wait for the current turn to become idle";
  }
}
/** Deleting or forking needs a session whose turn has stopped. */
export class TurnActive extends Enveloped<TurnActive>()("TurnActive", {
  action: Schema.Literal("delete", "fork"),
}) {
  override get message(): string {
    return this.action === "delete"
      ? "Cancel the active turn before deleting the session"
      : "Wait for the current turn to stop before forking";
  }
}
export class SessionNotDeleted extends Definite("SessionNotDeleted")<{}> {
  override get message(): string {
    return "Delete the session before purging its storage";
  }
}
/** Input arrived during a turn on a harness that cannot steer one. */
export class SteeringUnsupported extends Enveloped<SteeringUnsupported>()("SteeringUnsupported", {
  harness: Schema.String,
}) {
  override get message(): string {
    return "This harness cannot steer an active turn";
  }
}
export class UnknownToolCall extends Enveloped<UnknownToolCall>()("UnknownToolCall", {
  callId: Schema.String,
}) {
  // The official SDK retries a tool result submitted before the call was registered only
  // when the response is a 400 whose `code` is `invalid_request_error` and whose message
  // is exactly this text (openai/lib/agents/agent-session-stream.js, `#submit`).
  override get message(): string {
    return `Unknown pending tool call: ${this.callId}`;
  }
}
/** The deployment no longer registers the session's harness at its original revision. */
export class ExecutorVersionIncompatible extends Enveloped<ExecutorVersionIncompatible>()(
  "ExecutorVersionIncompatible",
  { harness: Schema.String, revision: Schema.String },
) {
  override get message(): string {
    return "Session requires its original harness revision";
  }
}
export class StreamLimitExceeded extends Definite("StreamLimitExceeded")<{
  readonly limit: number;
}> {
  override get message(): string {
    return "Too many live streams for this session";
  }
}
/** The turn exists but belongs to another subagent, or to none. */
export class SubagentTurnMismatch extends Definite("SubagentTurnMismatch")<{
  readonly subagentId: string;
  readonly turnId: string;
}> {
  override get message(): string {
    return "Subagent turn not found";
  }
}

// --- Domain: agent configuration ----------------------------------------------------

export const CAPABILITIES = [
  "configuration",
  "subagents",
  "mcp",
  "web_search",
  "tool_search",
  "programmatic_tool_calling",
  "environment_mcp_credentials",
  "image_input",
  "image_function_results",
  "environment_capabilities",
  "configured_environment",
  "environment_fork",
  "workspace_inheritance",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
const CAPABILITY_MESSAGES: Record<Capability, string> = {
  configuration: "The selected harness does not support this configuration",
  subagents: "The selected harness does not support subagents",
  mcp: "The selected harness does not support MCP servers",
  web_search: "The selected harness or model alias does not support web search",
  tool_search: "The selected harness does not support deferred tool loading",
  programmatic_tool_calling: "Programmatic tool calling requires a configured isolated code runner",
  environment_mcp_credentials:
    "Environment-origin MCP cannot use vault credentials or request metadata",
  image_input: "The selected harness does not support image input",
  image_function_results: "The selected harness does not support image function results",
  environment_capabilities: "The selected harness does not support environment skills or plugins",
  configured_environment:
    "Configured environments require an environment driver and object storage",
  environment_fork: "Forking a configured environment requires an environment driver",
  workspace_inheritance: "This environment driver cannot inherit a workspace",
};
/** The selected harness, model alias or deployment cannot serve this configuration. */
export class CapabilityUnsupported extends Enveloped<CapabilityUnsupported>()(
  "CapabilityUnsupported",
  { capability: Schema.Literal(...CAPABILITIES), harness: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return CAPABILITY_MESSAGES[this.capability];
  }
}
export class ModelNotRegistered extends Definite("ModelNotRegistered")<{
  readonly alias: string;
}> {
  override get message(): string {
    return "Model is not registered in this deployment";
  }
}
export class DelegateUnavailable extends Definite("DelegateUnavailable")<{
  readonly alias: string;
}> {
  override get message(): string {
    return `Delegate preset ${this.alias} is not registered in this deployment`;
  }
}
/** A function tool claims a name the delegation protocol reserves. */
export class ReservedToolName extends Definite("ReservedToolName")<{}> {
  override get message(): string {
    return "Subagent delegation reserves cf_delegate, cf_wait and cf_close";
  }
}
export class McpPlacementInvalid extends Definite("McpPlacementInvalid")<{
  readonly rule: "environment_required" | "stdio_in_service";
}> {
  override get message(): string {
    return this.rule === "environment_required"
      ? "Environment-origin MCP requires an execution environment"
      : "Stdio MCP runs in the execution environment";
  }
}
export class McpTransportUnsupported extends Definite("McpTransportUnsupported")<{
  readonly transport: string;
}> {
  override get message(): string {
    return "Expected HTTP MCP";
  }
}
export class NetworkPolicyBroadened extends Definite("NetworkPolicyBroadened")<{
  readonly rule: "access" | "domains";
}> {
  override get message(): string {
    return this.rule === "access"
      ? "Session cannot broaden its template network policy"
      : "Session domains must be allowed by its template";
  }
}
export class ImageLimitExceeded extends Enveloped<ImageLimitExceeded>()("ImageLimitExceeded", {
  limit: Schema.Number,
  scope: Schema.Literal("request", "turn"),
}) {
  override get message(): string {
    return this.scope === "request"
      ? `At most ${this.limit} distinct remote images per request`
      : `A turn may reference at most ${this.limit} remote images`;
  }
}

// --- Domain: files ------------------------------------------------------------------

export class InputFileInvalid extends Definite("InputFileInvalid")<{}> {
  override get message(): string {
    return "Expected a multipart file";
  }
}
export class FileTooLarge extends Definite("FileTooLarge")<{
  readonly kind: "input" | "inline";
}> {
  override get message(): string {
    return this.kind === "input"
      ? "Environment input files exceed 50 MiB"
      : "Inline file exceeds 5 MiB";
  }
}
export class FileExpired extends Definite("FileExpired")<{ readonly id: string }> {
  override get message(): string {
    return "File not found";
  }
}

// --- Domain: skills -----------------------------------------------------------------

export class SkillInvalid extends Definite("SkillInvalid")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason;
  }
}
const SKILL_LIMITS = {
  upload: "Skill upload exceeds 16 MiB",
  expanded: "Expanded skill exceeds 32 MiB",
  bundle: "Skill bundles are limited to 4 MB",
  stored: "Invalid skill size",
} as const;
export class SkillTooLarge extends Definite("SkillTooLarge")<{
  readonly limit: keyof typeof SKILL_LIMITS;
}> {
  override get message(): string {
    return SKILL_LIMITS[this.limit];
  }
}
export class SkillVersionIsDefault extends Definite("SkillVersionIsDefault")<{
  readonly version: string;
}> {
  override get message(): string {
    return "Select another default version or delete the entire skill";
  }
}
export class SkillPathInvalid extends Definite("SkillPathInvalid")<{ readonly path: string }> {
  override get message(): string {
    return `Invalid skill path: ${this.path}`;
  }
}
export class SkillManifestMissing extends Definite("SkillManifestMissing")<{}> {
  override get message(): string {
    return "A bundle must contain SKILL.md";
  }
}
export class SkillMissing extends Definite("SkillMissing")<{
  readonly reason: "bundle" | "not_installed";
}> {
  override get message(): string {
    return this.reason === "bundle" ? "Skill bundle not found" : "Skill is not installed";
  }
}
export class SkillFileMissing extends Definite("SkillFileMissing")<{ readonly path: string }> {
  override get message(): string {
    return "Skill file not found";
  }
}
export class SkillIntegrityMismatch extends Definite("SkillIntegrityMismatch")<{}> {
  override get message(): string {
    return "Skill content does not match its reference";
  }
}

// --- Domain: vaults and credentials --------------------------------------------------

export class CredentialAmbiguous extends Definite("CredentialAmbiguous")<{
  readonly reason: "multiple_matches" | "inline_and_vault";
}> {
  override get message(): string {
    return this.reason === "multiple_matches"
      ? "Select one matching MCP credential"
      : "Use either inline or vault authorization";
  }
}
export class CredentialNotFound extends Definite("CredentialNotFound")<{}> {
  override get message(): string {
    return "Matching attached credential not found";
  }
}
export class CredentialExpired extends Definite("CredentialExpired")<{
  readonly reason: "expired" | "refresh_missing";
}> {
  override get message(): string {
    return this.reason === "expired"
      ? "MCP credential expired; rotate the credential"
      : "Missing OAuth refresh configuration";
  }
}
/** The token endpoint refused the grant itself; only rotation clears it. */
export class CredentialRefreshRejected extends Definite("CredentialRefreshRejected")<{}> {
  override get message(): string {
    return "The token endpoint rejected the OAuth refresh; rotate the credential";
  }
}
const REFRESH_FAILURES = {
  endpoint: "The token endpoint failed; retry later",
  response: "Invalid OAuth refresh response",
  timeout: "OAuth refresh timed out",
  unknown: "OAuth refresh outcome is unknown; rotate the credential before retrying",
} as const;
export class CredentialRefreshFailed extends Definite("CredentialRefreshFailed")<{
  readonly reason: keyof typeof REFRESH_FAILURES;
}> {
  override get message(): string {
    return REFRESH_FAILURES[this.reason];
  }
}
/** A refresh whose answer was lost is still reserved; the token may have been consumed. */
export class CredentialRefreshIndeterminate extends Definite("CredentialRefreshIndeterminate")<{}> {
  override get message(): string {
    return "OAuth refresh outcome is unknown; rotate the credential";
  }
}
export class CredentialChanged extends Definite("CredentialChanged")<{}> {
  override get message(): string {
    return "Credential was rotated during refresh";
  }
}
export class CredentialRotationInvalid extends Definite("CredentialRotationInvalid")<{
  readonly rule: "auth_type" | "refresh_missing" | "auth_method";
}> {
  override get message(): string {
    if (this.rule === "auth_type") return "Credential authentication type cannot change";
    if (this.rule === "refresh_missing") return "Credential has no refresh configuration";
    return "OAuth authentication method cannot change";
  }
}

// --- Runtime protocol -----------------------------------------------------------------

/** A runtime batch names state this session never created, or breaks the cursor sequence. */
export class InvalidRuntimeEvent extends Definite("InvalidRuntimeEvent")<{
  readonly code: "invalid_runtime_event" | "invalid_runtime_cursor";
  readonly message: string;
}> {}
/** The runtime refused a command for good; it is dropped, never retried. */
export class CommandRejected extends Definite("CommandRejected")<{
  readonly code: string;
  readonly message: string;
}> {}
/** No such job on the runtime; a command cannot apply. */
export class ExecutionMissing extends Definite("ExecutionMissing")<{
  readonly message: string;
}> {}
/** The runtime answered start or checkpoint with a definite rejection; the turn fails with its code. */
export class RuntimeRejected extends Definite("RuntimeRejected")<{
  readonly status: Status;
  readonly code: string;
  readonly message: string;
}> {}
export class CheckpointIncompatible extends Definite("CheckpointIncompatible")<{
  readonly message: string;
}> {}
/** No answer, or an answer nobody can classify: the only retryable failure. */
export class TransportFailure extends Data.TaggedError("TransportFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation} failed`;
  }
}

// --- Runtime: HarnessDO and Containers -----------------------------------------------

export class HarnessUnknown extends Definite("HarnessUnknown")<{ readonly harness: string }> {
  override get message(): string {
    return "Unknown Container harness";
  }
}
/** The execution's checkpoint was written by another harness or revision. */
export class CheckpointHarnessMismatch extends Definite("CheckpointHarnessMismatch")<{
  readonly harness: string;
  readonly revision: string;
}> {
  override get message(): string {
    return "Checkpoint belongs to another harness version";
  }
}
export class CheckpointMissing extends Definite("CheckpointMissing")<{ readonly key: string }> {
  override get message(): string {
    return "Native checkpoint is missing";
  }
}
export class AssignmentConflict extends Definite("AssignmentConflict")<{
  readonly sessionId: string;
}> {
  override get message(): string {
    return "Container already belongs to another session";
  }
}
export class NetworkPolicyConflict extends Definite("NetworkPolicyConflict")<{}> {
  override get message(): string {
    return "Network access must be configured before the environment starts";
  }
}
export class ArtifactListFailed extends Definite("ArtifactListFailed")<{}> {
  override get message(): string {
    return "Artifact listing failed";
  }
}
export class ArtifactLimitExceeded extends Definite("ArtifactLimitExceeded")<{}> {
  override get message(): string {
    return "Artifacts exceed 200 MiB per file or 500 MiB per turn";
  }
}

// --- Runtime: environment workspace ---------------------------------------------------

export class EnvironmentNotFound extends Definite("EnvironmentNotFound")<{
  readonly environmentId: string;
}> {
  override get message(): string {
    return "Environment not found";
  }
}
export class EnvironmentNotReady extends Definite("EnvironmentNotReady")<{
  readonly reason: "source" | "upload";
}> {
  override get message(): string {
    return this.reason === "source"
      ? "Source environment is not connected"
      : "Wait for the environment to connect";
  }
}
export class EnvironmentConflict extends Definite("EnvironmentConflict")<{
  readonly environmentId: string;
}> {
  override get message(): string {
    return "Harness already owns another environment";
  }
}
/** Setup started and never committed; its commands may have run, so it is never replayed. */
export class EnvironmentSetupIndeterminate extends Definite("EnvironmentSetupIndeterminate")<{}> {
  override get message(): string {
    return "Environment setup did not complete; create a new session";
  }
}
export class EnvironmentSetupFailed extends Definite("EnvironmentSetupFailed")<{
  readonly reason: "command" | "capability_result";
}> {
  override get message(): string {
    return this.reason === "command"
      ? "Environment command failed"
      : "Invalid capability installation result";
  }
}
const ENVIRONMENT_WRITES = {
  file: "Environment file write failed",
  upload_missing: "Environment upload missing",
  upload: "Environment upload write failed",
} as const;
export class EnvironmentWriteFailed extends Definite("EnvironmentWriteFailed")<{
  readonly reason: keyof typeof ENVIRONMENT_WRITES;
}> {
  override get message(): string {
    return ENVIRONMENT_WRITES[this.reason];
  }
}
export class EnvironmentListFailed extends Definite("EnvironmentListFailed")<{}> {
  override get message(): string {
    return "Environment listing failed";
  }
}
export class EnvironmentDriverUnavailable extends Definite("EnvironmentDriverUnavailable")<{}> {
  override get message(): string {
    return "Environment driver is unavailable";
  }
}
export class CapabilityBudgetExceeded extends Definite("CapabilityBudgetExceeded")<{}> {
  override get message(): string {
    return "Skills and plugins exceed 64 MiB per environment";
  }
}
const STORED_OBJECTS = {
  environment_configuration: "Environment configuration not found",
  skill_bundle: "Pinned skill bundle not found",
  input_file: "Input file not found",
  file_content: "File content not found",
  skill_content: "Skill content not found",
  artifact_content: "Artifact content not found",
} as const;
/** An object a durable record names is gone from object storage. */
export class StoredObjectMissing extends Definite("StoredObjectMissing")<{
  readonly object: keyof typeof STORED_OBJECTS;
}> {
  override get message(): string {
    return STORED_OBJECTS[this.object];
  }
}
export class ObjectStorageUnavailable extends Definite("ObjectStorageUnavailable")<{}> {
  override get message(): string {
    return "Object storage is not configured";
  }
}
/** A configured upstream answered with a redirect; credentials never follow one. */
export class UpstreamRedirect extends Definite("UpstreamRedirect")<{
  readonly operation: string;
}> {
  override get message(): string {
    return "Configured upstream returned a redirect";
  }
}

// --- Runtime: model gateway -----------------------------------------------------------

export class ModelNotFound extends Definite("ModelNotFound")<{ readonly model: string }> {
  override get message(): string {
    return "No model is registered with this name";
  }
}
export class ModelProtocolMismatch extends Definite("ModelProtocolMismatch")<{
  readonly protocol: string;
}> {
  override get message(): string {
    return "Model preset does not support this harness protocol";
  }
}
export class ModelInputMissing extends Definite("ModelInputMissing")<{}> {
  override get message(): string {
    return "Model input is required";
  }
}
export class ModelInputTooLarge extends Definite("ModelInputTooLarge")<{}> {
  override get message(): string {
    return "Model input exceeds 4 MiB";
  }
}
export class ModelInputUnsupported extends Definite("ModelInputUnsupported")<{}> {
  override get message(): string {
    return "Unsupported translated model input; use a native model preset for provider-specific content";
  }
}
export class ModelOutputFailed extends Definite("ModelOutputFailed")<{}> {
  override get message(): string {
    return "Upstream model output failed or was incomplete";
  }
}

// --- Runtime: programmatic tool calling ----------------------------------------------

export class ProgrammaticExecutionFailed extends Definite("ProgrammaticExecutionFailed")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}
/** A tool call ended without a confirmed result: the code may have had effects. */
export class ProgrammaticOutcomeUncertain extends Definite("ProgrammaticOutcomeUncertain")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}
export class ProgrammaticInputTooLarge extends Definite("ProgrammaticInputTooLarge")<{}> {
  override get message(): string {
    return "Code and arguments exceed 256 KB";
  }
}

// --- Wire validation ------------------------------------------------------------------

/** A request body, query or RPC argument failed schema validation. */
export class InvalidRequest extends Definite("InvalidRequest")<{ readonly issues: string }> {
  override get message(): string {
    return this.issues;
  }
}
export class InvalidJson extends Definite("InvalidJson")<{}> {
  override get message(): string {
    return "Request body must be valid JSON";
  }
}
export class InvalidTenant extends Definite("InvalidTenant")<{}> {
  override get message(): string {
    return "Tenant must be nonempty and at most 256 characters";
  }
}
export class Unauthorized extends Definite("Unauthorized")<{}> {
  override get message(): string {
    return "Authentication required";
  }
}
export class BodyTooLarge extends Definite("BodyTooLarge")<{}> {
  override get message(): string {
    return "Request exceeds its upload limit";
  }
}

// --- The closed union -----------------------------------------------------------------

const DOMAIN_CLASSES = [
  RecordTooLarge,
  RecordNotFound,
  InvalidCursor,
  StorageFailure,
  SessionNotFound,
  InvalidSessionState,
  Superseded,
  ContainerUnassigned,
  IdempotencyConflict,
  SessionFailed,
  TurnCheckpointing,
  TurnActive,
  SessionNotDeleted,
  SteeringUnsupported,
  UnknownToolCall,
  ExecutorVersionIncompatible,
  StreamLimitExceeded,
  SubagentTurnMismatch,
  CapabilityUnsupported,
  ModelNotRegistered,
  DelegateUnavailable,
  ReservedToolName,
  McpPlacementInvalid,
  McpTransportUnsupported,
  NetworkPolicyBroadened,
  ImageLimitExceeded,
  InputFileInvalid,
  FileTooLarge,
  FileExpired,
  SkillInvalid,
  SkillTooLarge,
  SkillVersionIsDefault,
  SkillPathInvalid,
  SkillManifestMissing,
  SkillMissing,
  SkillFileMissing,
  SkillIntegrityMismatch,
  CredentialAmbiguous,
  CredentialNotFound,
  CredentialExpired,
  CredentialRefreshRejected,
  CredentialRefreshFailed,
  CredentialRefreshIndeterminate,
  CredentialChanged,
  CredentialRotationInvalid,
  InvalidRuntimeEvent,
  CommandRejected,
  ExecutionMissing,
  RuntimeRejected,
  CheckpointIncompatible,
  TransportFailure,
  HarnessUnknown,
  CheckpointHarnessMismatch,
  CheckpointMissing,
  AssignmentConflict,
  NetworkPolicyConflict,
  ArtifactListFailed,
  ArtifactLimitExceeded,
  EnvironmentNotFound,
  EnvironmentNotReady,
  EnvironmentConflict,
  EnvironmentSetupIndeterminate,
  EnvironmentSetupFailed,
  EnvironmentWriteFailed,
  EnvironmentListFailed,
  EnvironmentDriverUnavailable,
  CapabilityBudgetExceeded,
  StoredObjectMissing,
  ObjectStorageUnavailable,
  UpstreamRedirect,
  ModelNotFound,
  ModelProtocolMismatch,
  ModelInputMissing,
  ModelInputTooLarge,
  ModelInputUnsupported,
  ModelOutputFailed,
  ProgrammaticExecutionFailed,
  ProgrammaticOutcomeUncertain,
  ProgrammaticInputTooLarge,
  InvalidRequest,
  InvalidJson,
  InvalidTenant,
  Unauthorized,
  BodyTooLarge,
] as const;
export type DomainError = InstanceType<(typeof DOMAIN_CLASSES)[number]>;
export type DomainTag = DomainError["_tag"];
export const isDomainError = (value: unknown): value is DomainError =>
  DOMAIN_CLASSES.some((cls) => value instanceof cls);

// --- Projection: the only place that knows HTTP --------------------------------------

type Wire = readonly [Status, string];
/** Tags whose runtime answer carries its own code; every other tag has a fixed one. */
type DynamicTag = "RuntimeRejected" | "CommandRejected" | "InvalidRuntimeEvent";
type StaticTag = Exclude<DomainTag, DynamicTag>;
const WIRE = {
  RecordTooLarge: [413, "storage_record_too_large"],
  RecordNotFound: [404, "not_found"],
  InvalidCursor: [400, "invalid_cursor"],
  StorageFailure: [500, "internal_error"],
  SessionNotFound: [404, "not_found"],
  InvalidSessionState: [409, "invalid_session_state"],
  Superseded: [409, "stale_generation"],
  ContainerUnassigned: [409, "unassigned_container"],
  IdempotencyConflict: [409, "idempotency_conflict"],
  SessionFailed: [409, "session_failed"],
  TurnCheckpointing: [409, "turn_checkpointing"],
  TurnActive: [409, "active_turn"],
  SessionNotDeleted: [409, "not_deleted"],
  SteeringUnsupported: [409, "active_turn_not_steerable"],
  UnknownToolCall: [400, "invalid_request_error"],
  ExecutorVersionIncompatible: [503, "executor_version_incompatible"],
  StreamLimitExceeded: [429, "stream_limit"],
  SubagentTurnMismatch: [404, "not_found"],
  CapabilityUnsupported: [422, "unsupported_capability"],
  ModelNotRegistered: [422, "unsupported_model"],
  DelegateUnavailable: [503, "delegate_unavailable"],
  ReservedToolName: [400, "invalid_request"],
  McpPlacementInvalid: [400, "invalid_request"],
  McpTransportUnsupported: [400, "invalid_request"],
  NetworkPolicyBroadened: [400, "network_policy_broadened"],
  ImageLimitExceeded: [413, "image_limit"],
  InputFileInvalid: [400, "invalid_file"],
  FileTooLarge: [413, "file_too_large"],
  FileExpired: [404, "not_found"],
  SkillInvalid: [400, "invalid_skill"],
  SkillTooLarge: [413, "skill_too_large"],
  SkillVersionIsDefault: [409, "default_skill_version"],
  SkillPathInvalid: [400, "invalid_skill_path"],
  SkillManifestMissing: [400, "missing_skill"],
  SkillMissing: [404, "skill_missing"],
  SkillFileMissing: [404, "skill_file_missing"],
  SkillIntegrityMismatch: [409, "skill_integrity"],
  CredentialAmbiguous: [400, "ambiguous_credential"],
  CredentialNotFound: [404, "not_found"],
  CredentialExpired: [422, "credential_expired"],
  CredentialRefreshRejected: [422, "credential_refresh_rejected"],
  CredentialRefreshFailed: [422, "credential_refresh_failed"],
  CredentialRefreshIndeterminate: [409, "outcome_unknown"],
  CredentialChanged: [409, "credential_changed"],
  CredentialRotationInvalid: [400, "invalid_request"],
  ExecutionMissing: [404, "execution_missing"],
  CheckpointIncompatible: [409, "invalid_checkpoint"],
  TransportFailure: [500, "internal_error"],
  HarnessUnknown: [400, "unsupported_harness"],
  CheckpointHarnessMismatch: [409, "checkpoint_incompatible"],
  CheckpointMissing: [409, "checkpoint_missing"],
  AssignmentConflict: [409, "assignment_conflict"],
  NetworkPolicyConflict: [409, "network_policy_conflict"],
  ArtifactListFailed: [503, "artifact_list_failed"],
  ArtifactLimitExceeded: [413, "artifact_limit"],
  EnvironmentNotFound: [404, "not_found"],
  EnvironmentNotReady: [409, "environment_not_ready"],
  EnvironmentConflict: [409, "environment_conflict"],
  EnvironmentSetupIndeterminate: [409, "outcome_unknown"],
  EnvironmentSetupFailed: [422, "environment_setup_failed"],
  EnvironmentWriteFailed: [503, "environment_write_failed"],
  EnvironmentListFailed: [503, "environment_list_failed"],
  EnvironmentDriverUnavailable: [503, "environment_unavailable"],
  CapabilityBudgetExceeded: [413, "capability_limit"],
  StoredObjectMissing: [404, "not_found"],
  ObjectStorageUnavailable: [503, "storage_unavailable"],
  UpstreamRedirect: [503, "upstream_redirect"],
  ModelNotFound: [404, "model_not_found"],
  ModelProtocolMismatch: [400, "model_protocol_mismatch"],
  ModelInputMissing: [400, "missing_model_input"],
  ModelInputTooLarge: [413, "model_input_too_large"],
  ModelInputUnsupported: [400, "unsupported_model_input"],
  ModelOutputFailed: [503, "model_output_failed"],
  ProgrammaticExecutionFailed: [422, "programmatic_execution_failed"],
  ProgrammaticOutcomeUncertain: [422, "programmatic_execution_uncertain"],
  ProgrammaticInputTooLarge: [413, "programmatic_input_too_large"],
  InvalidRequest: [400, "invalid_request"],
  InvalidJson: [400, "invalid_json"],
  InvalidTenant: [400, "invalid_tenant"],
  Unauthorized: [401, "unauthorized"],
  BodyTooLarge: [413, "body_too_large"],
} as const satisfies { readonly [K in StaticTag]: Wire };
const wire = (error: DomainError): Wire => {
  switch (error._tag) {
    case "RuntimeRejected":
      return [error.status, error.code];
    case "CommandRejected":
    case "InvalidRuntimeEvent":
      return [409, error.code];
    default:
      return WIRE[error._tag];
  }
};
/** The one HTTP/RPC projection: status, code and message for every domain failure. */
export const toApiError = (error: DomainError | ApiError): ApiError => {
  if (error._tag === "ApiError") return error;
  const [status, code] = wire(error);
  return new ApiError(status, code, error.message);
};
/**
 * Anything a boundary may catch, as a tagged failure: a domain failure or an `ApiError`
 * as themselves, an RPC wire name as the `ApiError` it encodes, the rest as nothing.
 */
export function caughtFailure(error: unknown): DomainError | ApiError | undefined {
  if (isDomainError(error) || error instanceof ApiError) return error;
  return error instanceof Error ? remoteApiError(error) : undefined;
}
/** The HTTP projection of anything a boundary may catch. */
export function projectApiError(error: unknown): ApiError | undefined {
  const failure = caughtFailure(error);
  return failure && toApiError(failure);
}
/**
 * Conflicts a retry cannot resolve; the SDK honors `x-should-retry: false`. A failure
 * that arrived by wire name is matched by the code these tags project to.
 */
const PERMANENT_TAGS: readonly StaticTag[] = [
  "IdempotencyConflict",
  "TurnActive",
  "SessionFailed",
  "TurnCheckpointing",
  "SteeringUnsupported",
  "CredentialRefreshIndeterminate",
  "EnvironmentSetupIndeterminate",
  "NetworkPolicyConflict",
  "InvalidSessionState",
  "SessionNotDeleted",
  "EnvironmentConflict",
];
const PERMANENT_CODES: ReadonlySet<string> = new Set(PERMANENT_TAGS.map((tag) => WIRE[tag][1]));
export const isPermanent = (error: DomainError | ApiError): boolean =>
  error._tag === "ApiError"
    ? PERMANENT_CODES.has(error.code)
    : (PERMANENT_TAGS as readonly string[]).includes(error._tag);
/** A thrown definite answer: an `ApiError`, its RPC wire name, or a plain `{ status, code }`. */
export function rejection(
  cause: unknown,
): { status: Status; code: string; message: string } | undefined {
  const known = projectApiError(cause);
  // A fresh record, never the caught instance: `Data` errors copy own fields, tag included.
  if (known) return { status: known.status, code: known.code, message: known.message };
  if (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    "code" in cause &&
    isStatus(cause.status) &&
    typeof cause.code === "string"
  )
    return {
      status: cause.status,
      code: cause.code,
      message: "message" in cause && typeof cause.message === "string" ? cause.message : cause.code,
    };
  return undefined;
}

// --- RPC envelope ---------------------------------------------------------------------

/** A plain `ApiError` inside an envelope: its tag, status and code travel as data. */
export const ApiErrorSchema = Schema.transform(
  Schema.TaggedStruct("ApiError", {
    status: Schema.Literal(400, 401, 404, 409, 413, 422, 429, 500, 503),
    code: Schema.String,
    message: Schema.String,
  }),
  Schema.instanceOf(ApiError),
  {
    strict: true,
    decode: ({ status, code, message }) => new ApiError(status, code, message),
    encode: (error) => ({
      _tag: "ApiError" as const,
      status: error.status,
      code: error.code,
      message: error.message,
    }),
  },
);
/** Expected failures cross DO RPC as data, without platform error logs; the rest still throw. */
export const RpcFailure = Schema.Union(
  RecordTooLarge,
  RecordNotFound,
  InvalidCursor,
  SessionNotFound,
  InvalidSessionState,
  IdempotencyConflict,
  SessionFailed,
  TurnCheckpointing,
  TurnActive,
  SteeringUnsupported,
  UnknownToolCall,
  ExecutorVersionIncompatible,
  CapabilityUnsupported,
  ImageLimitExceeded,
  ApiErrorSchema,
);
export type RpcFailure = typeof RpcFailure.Type;
export const isRpcFailure: (value: unknown) => value is RpcFailure = Schema.is(RpcFailure);
export const rpcEnvelope = <A, I>(success: Schema.Schema<A, I>) =>
  Schema.Either({ left: RpcFailure, right: success });
/** Callee side: an expected failure becomes data; anything else still throws across RPC. */
export const encodeRpc = <A, I, E, R>(
  envelope: Schema.Schema<Either.Either<A, RpcFailure>, I>,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.map((value): Either.Either<A, RpcFailure> => Either.right(value)),
    Effect.catchIf(
      (error: E): error is E & RpcFailure => isRpcFailure(error),
      (error): Effect.Effect<Either.Either<A, RpcFailure>> => Effect.succeed(Either.left(error)),
    ),
    Effect.map(Schema.encodeSync(envelope)),
  );
/** Caller side: the envelope decodes back into instances, so a failure re-enters the fiber tagged. */
export const decodeRpc =
  <A, I>(envelope: Schema.Schema<Either.Either<A, RpcFailure>, I>) =>
  (encoded: unknown): Effect.Effect<A, RpcFailure> =>
    Schema.decodeUnknown(envelope)(encoded).pipe(
      Effect.orDie,
      Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed })),
    );
