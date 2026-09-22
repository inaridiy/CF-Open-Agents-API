import { type Cause, Data, Effect, Either, Schema, type Types } from "effect";

import { ApiError, isStatus, remoteApiError, type Status } from "./api-error.js";

/**
 * The failure vocabulary, one section per layer. Each class names the rule that failed
 * in that layer's own terms and carries the data a caller needs to react; none of them
 * knows an HTTP status. `toApiError` at the end of this file is the only place that maps
 * a tag to `(status, code)`; it is total over the closed union, so a tag without a
 * mapping is a type error.
 *
 * Most failures have no behavior beyond that projection: they are rows of the `DEFINITE`
 * table below, which holds the status, the code and the message the row's props render,
 * and each one is declared as a class of the same name so callers keep naming the rule.
 * A failure is hand-written when something reads it as more than a projection: the
 * `Enveloped` ones (`Schema.TaggedError`) whose values cross Durable Object RPC as data
 * and decode back into instances, the two retryable ones, and the runtime answers that
 * carry their own status, code or message.
 *
 * A definite failure reports `ApiError`'s wire name through `name`, so a caller behind
 * an un-enveloped RPC hop still recovers its status and code (the platform reads `name`
 * and `message` as ordinary properties). `TransportFailure` and `StorageFailure` are
 * deliberately not named that way: a caller must never mistake them for a definite
 * answer.
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
/** A definite failure whose class is written by hand: it answers with its own props. */
const Definite = <Tag extends string>(tag: Tag) => wired(Data.TaggedError(tag));
/** A definite failure that may cross DO RPC as envelope data. */
const Enveloped =
  <Self = never>() =>
  <Tag extends string, Fields extends Schema.Struct.Fields>(tag: Tag, fields: Fields) =>
    wired(Schema.TaggedError<Self>()(tag, fields));

// --- The definite table ---------------------------------------------------------------

type Wire = readonly [Status, string];
/** What one definite failure is: its wire answer and the message its props render. */
type DefiniteRow = readonly [Status, string, string | ((props: never) => string)];
/** A message that does not read the props the failure carries; the props are still typed. */
const fixed =
  <Props>(message: string): ((props: Props) => string) =>
  () =>
    message;

const CAPABILITIES = [
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
const SKILL_LIMITS = {
  upload: "Skill upload exceeds 16 MiB",
  expanded: "Expanded skill exceeds 32 MiB",
  bundle: "Skill bundles are limited to 4 MB",
  stored: "Invalid skill size",
} as const;
const REFRESH_FAILURES = {
  endpoint: "The token endpoint failed; retry later",
  response: "Invalid OAuth refresh response",
  timeout: "OAuth refresh timed out",
  unknown: "OAuth refresh outcome is unknown; rotate the credential before retrying",
} as const;
const ENVIRONMENT_WRITES = {
  file: "Environment file write failed",
  upload_missing: "Environment upload missing",
  upload: "Environment upload write failed",
} as const;
const STORED_OBJECTS = {
  environment_configuration: "Environment configuration not found",
  skill_bundle: "Pinned skill bundle not found",
  input_file: "Input file not found",
  file_content: "File content not found",
  skill_content: "Skill content not found",
  artifact_content: "Artifact content not found",
} as const;

/**
 * Every failure whose whole behavior is its projection, in layer order. A row is the
 * one place a rule is added: the class below it, the `WIRE` table and the permanent-code
 * set all read this row.
 */
const DEFINITE = {
  // Persistence.
  /** The durable execution identity moved on; the caller's work is void and stops silently. */
  Superseded: [
    409,
    "stale_generation",
    fixed<{ turnId: string; generation: number }>("Execution was superseded"),
  ],
  /** A HarnessDO row read before any session was assigned to the container. */
  ContainerUnassigned: [409, "unassigned_container", "Container has no session assignment"],

  // Domain: session lifecycle.
  SessionNotDeleted: [409, "not_deleted", "Delete the session before purging its storage"],
  StreamLimitExceeded: [
    429,
    "stream_limit",
    fixed<{ limit: number }>("Too many live streams for this session"),
  ],
  /** The turn exists but belongs to another subagent, or to none. */
  SubagentTurnMismatch: [
    404,
    "not_found",
    fixed<{ subagentId: string; turnId: string }>("Subagent turn not found"),
  ],

  // Domain: agent configuration.
  ModelNotRegistered: [
    422,
    "unsupported_model",
    fixed<{ alias: string }>("Model is not registered in this deployment"),
  ],
  DelegateUnavailable: [
    503,
    "delegate_unavailable",
    (p: { alias: string }) => `Delegate preset ${p.alias} is not registered in this deployment`,
  ],
  /** A function tool claims a name the delegation protocol reserves. */
  ReservedToolName: [
    400,
    "invalid_request",
    "Subagent delegation reserves cf_delegate, cf_wait and cf_close",
  ],
  McpPlacementInvalid: [
    400,
    "invalid_request",
    (p: { rule: "environment_required" | "stdio_in_service" }) =>
      p.rule === "environment_required"
        ? "Environment-origin MCP requires an execution environment"
        : "Stdio MCP runs in the execution environment",
  ],
  McpTransportUnsupported: [
    400,
    "invalid_request",
    fixed<{ transport: string }>("Expected HTTP MCP"),
  ],
  NetworkPolicyBroadened: [
    400,
    "network_policy_broadened",
    (p: { rule: "access" | "domains" }) =>
      p.rule === "access"
        ? "Session cannot broaden its template network policy"
        : "Session domains must be allowed by its template",
  ],

  // Domain: files.
  InputFileInvalid: [400, "invalid_file", "Expected a multipart file"],
  FileTooLarge: [
    413,
    "file_too_large",
    (p: { kind: "input" | "inline" }) =>
      p.kind === "input" ? "Environment input files exceed 50 MiB" : "Inline file exceeds 5 MiB",
  ],
  FileExpired: [404, "not_found", fixed<{ id: string }>("File not found")],

  // Domain: skills.
  SkillInvalid: [400, "invalid_skill", (p: { reason: string }) => p.reason],
  SkillTooLarge: [
    413,
    "skill_too_large",
    (p: { limit: keyof typeof SKILL_LIMITS }) => SKILL_LIMITS[p.limit],
  ],
  SkillVersionIsDefault: [
    409,
    "default_skill_version",
    fixed<{ version: string }>("Select another default version or delete the entire skill"),
  ],
  SkillPathInvalid: [
    400,
    "invalid_skill_path",
    (p: { path: string }) => `Invalid skill path: ${p.path}`,
  ],
  SkillManifestMissing: [400, "missing_skill", "A bundle must contain SKILL.md"],
  SkillMissing: [
    404,
    "skill_missing",
    (p: { reason: "bundle" | "not_installed" }) =>
      p.reason === "bundle" ? "Skill bundle not found" : "Skill is not installed",
  ],
  SkillFileMissing: [404, "skill_file_missing", fixed<{ path: string }>("Skill file not found")],
  SkillIntegrityMismatch: [409, "skill_integrity", "Skill content does not match its reference"],

  // Domain: vaults and credentials.
  CredentialAmbiguous: [
    400,
    "ambiguous_credential",
    (p: { reason: "multiple_matches" | "inline_and_vault" }) =>
      p.reason === "multiple_matches"
        ? "Select one matching MCP credential"
        : "Use either inline or vault authorization",
  ],
  CredentialNotFound: [404, "not_found", "Matching attached credential not found"],
  CredentialExpired: [
    422,
    "credential_expired",
    (p: { reason: "expired" | "refresh_missing" }) =>
      p.reason === "expired"
        ? "MCP credential expired; rotate the credential"
        : "Missing OAuth refresh configuration",
  ],
  /** The token endpoint refused the grant itself; only rotation clears it. */
  CredentialRefreshRejected: [
    422,
    "credential_refresh_rejected",
    "The token endpoint rejected the OAuth refresh; rotate the credential",
  ],
  CredentialRefreshFailed: [
    422,
    "credential_refresh_failed",
    (p: { reason: keyof typeof REFRESH_FAILURES }) => REFRESH_FAILURES[p.reason],
  ],
  /** A refresh whose answer was lost is still reserved; the token may have been consumed. */
  CredentialRefreshIndeterminate: [
    409,
    "outcome_unknown",
    "OAuth refresh outcome is unknown; rotate the credential",
  ],
  CredentialChanged: [409, "credential_changed", "Credential was rotated during refresh"],
  CredentialRotationInvalid: [
    400,
    "invalid_request",
    (p: { rule: "auth_type" | "refresh_missing" | "auth_method" }) => {
      if (p.rule === "auth_type") return "Credential authentication type cannot change";
      if (p.rule === "refresh_missing") return "Credential has no refresh configuration";
      return "OAuth authentication method cannot change";
    },
  ],

  // Runtime: HarnessDO and Containers.
  HarnessUnknown: [
    400,
    "unsupported_harness",
    fixed<{ harness: string }>("Unknown Container harness"),
  ],
  /** The execution's checkpoint was written by another harness or revision. */
  CheckpointHarnessMismatch: [
    409,
    "checkpoint_incompatible",
    fixed<{ harness: string; revision: string }>("Checkpoint belongs to another harness version"),
  ],
  CheckpointMissing: [
    409,
    "checkpoint_missing",
    fixed<{ key: string }>("Native checkpoint is missing"),
  ],
  AssignmentConflict: [
    409,
    "assignment_conflict",
    fixed<{ sessionId: string }>("Container already belongs to another session"),
  ],
  NetworkPolicyConflict: [
    409,
    "network_policy_conflict",
    "Network access must be configured before the environment starts",
  ],
  ArtifactListFailed: [503, "artifact_list_failed", "Artifact listing failed"],
  ArtifactLimitExceeded: [
    413,
    "artifact_limit",
    "Artifacts exceed 200 MiB per file or 500 MiB per turn",
  ],

  // Runtime: environment workspace.
  EnvironmentNotFound: [
    404,
    "not_found",
    fixed<{ environmentId: string }>("Environment not found"),
  ],
  EnvironmentNotReady: [
    409,
    "environment_not_ready",
    (p: { reason: "source" | "upload" }) =>
      p.reason === "source"
        ? "Source environment is not connected"
        : "Wait for the environment to connect",
  ],
  EnvironmentConflict: [
    409,
    "environment_conflict",
    fixed<{ environmentId: string }>("Harness already owns another environment"),
  ],
  /** Setup started and never committed; its commands may have run, so it is never replayed. */
  EnvironmentSetupIndeterminate: [
    409,
    "outcome_unknown",
    "Environment setup did not complete; create a new session",
  ],
  EnvironmentSetupFailed: [
    422,
    "environment_setup_failed",
    (p: { reason: "command" | "capability_result" }) =>
      p.reason === "command"
        ? "Environment command failed"
        : "Invalid capability installation result",
  ],
  EnvironmentWriteFailed: [
    503,
    "environment_write_failed",
    (p: { reason: keyof typeof ENVIRONMENT_WRITES }) => ENVIRONMENT_WRITES[p.reason],
  ],
  EnvironmentListFailed: [503, "environment_list_failed", "Environment listing failed"],
  EnvironmentDriverUnavailable: [
    503,
    "environment_unavailable",
    "Environment driver is unavailable",
  ],
  /** The Sandbox SDK signs backup URLs with R2 secrets the deployment did not set. */
  BackupCredentialsMissing: [
    503,
    "environment_unavailable",
    (p: { missing: readonly string[] }) =>
      `Sandbox backups need the secrets ${p.missing.join(", ")}; set them with wrangler secret put (LOCAL_BACKUPS=true under wrangler dev)`,
  ],
  CapabilityBudgetExceeded: [
    413,
    "capability_limit",
    "Skills and plugins exceed 64 MiB per environment",
  ],
  /** An object a durable record names is gone from object storage. */
  StoredObjectMissing: [
    404,
    "not_found",
    (p: { object: keyof typeof STORED_OBJECTS }) => STORED_OBJECTS[p.object],
  ],
  ObjectStorageUnavailable: [503, "storage_unavailable", "Object storage is not configured"],
  /** A configured upstream answered with a redirect; credentials never follow one. */
  UpstreamRedirect: [
    503,
    "upstream_redirect",
    fixed<{ operation: string }>("Configured upstream returned a redirect"),
  ],

  // Runtime: model gateway.
  ModelNotFound: [
    404,
    "model_not_found",
    fixed<{ model: string }>("No model is registered with this name"),
  ],
  ModelProtocolMismatch: [
    400,
    "model_protocol_mismatch",
    fixed<{ protocol: string }>("Model preset does not support this harness protocol"),
  ],
  ModelInputMissing: [400, "missing_model_input", "Model input is required"],
  ModelInputTooLarge: [413, "model_input_too_large", "Model input exceeds 4 MiB"],
  ModelInputUnsupported: [
    400,
    "unsupported_model_input",
    "Unsupported translated model input; use a native model preset for provider-specific content",
  ],
  ModelOutputFailed: [503, "model_output_failed", "Upstream model output failed or was incomplete"],

  // Runtime: programmatic tool calling.
  ProgrammaticExecutionFailed: [
    422,
    "programmatic_execution_failed",
    (p: { reason: string }) => p.reason,
  ],
  /** A tool call ended without a confirmed result: the code may have had effects. */
  ProgrammaticOutcomeUncertain: [
    422,
    "programmatic_execution_uncertain",
    (p: { reason: string }) => p.reason,
  ],
  ProgrammaticInputTooLarge: [
    413,
    "programmatic_input_too_large",
    "Code and arguments exceed 256 KB",
  ],

  // Wire validation.
  /** A request body, query or RPC argument failed schema validation. */
  InvalidRequest: [400, "invalid_request", (p: { issues: string }) => p.issues],
  InvalidJson: [400, "invalid_json", "Request body must be valid JSON"],
  InvalidTenant: [400, "invalid_tenant", "Tenant must be nonempty and at most 256 characters"],
  Unauthorized: [401, "unauthorized", "Authentication required"],
  BodyTooLarge: [413, "body_too_large", "Request exceeds its upload limit"],
} as const satisfies Record<string, DefiniteRow>;

type DefiniteTag = keyof typeof DEFINITE;
/** The props a row declares, through the parameter of the message it renders. */
type PropsOf<Tag extends DefiniteTag> = (typeof DEFINITE)[Tag][2] extends (props: infer P) => string
  ? P
  : {};
/**
 * The class a row yields: the tag as a literal, the props the row declared and the
 * yieldable error every failure is. The base is built dynamically, so the shape a caller
 * sees is stated here rather than inferred through the table's generics.
 */
type DefiniteClass<Tag extends string, Props> = new (
  props: Types.VoidIfEmpty<Readonly<Props>>,
) => Cause.YieldableError & { readonly _tag: Tag } & Readonly<Props>;
/** Every class the table produced, so the closed union needs no second list of them. */
const DEFINITE_CLASSES: (new (...args: never[]) => unknown)[] = [];
const definite = <Tag extends DefiniteTag>(tag: Tag) => {
  const render = DEFINITE[tag][2];
  class Failure extends Data.TaggedError<string>(tag)<Record<string, unknown>> {
    override get message(): string {
      return typeof render === "function" ? render(this as never) : render;
    }
  }
  const cls = wired(Failure) as unknown as DefiniteClass<Tag, PropsOf<Tag>>;
  DEFINITE_CLASSES.push(cls);
  return cls;
};

// --- The definite classes, one line per row -------------------------------------------

export class Superseded extends definite("Superseded") {}
export class ContainerUnassigned extends definite("ContainerUnassigned") {}
export class SessionNotDeleted extends definite("SessionNotDeleted") {}
export class StreamLimitExceeded extends definite("StreamLimitExceeded") {}
export class SubagentTurnMismatch extends definite("SubagentTurnMismatch") {}
export class ModelNotRegistered extends definite("ModelNotRegistered") {}
export class DelegateUnavailable extends definite("DelegateUnavailable") {}
export class ReservedToolName extends definite("ReservedToolName") {}
export class McpPlacementInvalid extends definite("McpPlacementInvalid") {}
export class McpTransportUnsupported extends definite("McpTransportUnsupported") {}
export class NetworkPolicyBroadened extends definite("NetworkPolicyBroadened") {}
export class InputFileInvalid extends definite("InputFileInvalid") {}
export class FileTooLarge extends definite("FileTooLarge") {}
export class FileExpired extends definite("FileExpired") {}
export class SkillInvalid extends definite("SkillInvalid") {}
export class SkillTooLarge extends definite("SkillTooLarge") {}
export class SkillVersionIsDefault extends definite("SkillVersionIsDefault") {}
export class SkillPathInvalid extends definite("SkillPathInvalid") {}
export class SkillManifestMissing extends definite("SkillManifestMissing") {}
export class SkillMissing extends definite("SkillMissing") {}
export class SkillFileMissing extends definite("SkillFileMissing") {}
export class SkillIntegrityMismatch extends definite("SkillIntegrityMismatch") {}
export class CredentialAmbiguous extends definite("CredentialAmbiguous") {}
export class CredentialNotFound extends definite("CredentialNotFound") {}
export class CredentialExpired extends definite("CredentialExpired") {}
export class CredentialRefreshRejected extends definite("CredentialRefreshRejected") {}
export class CredentialRefreshFailed extends definite("CredentialRefreshFailed") {}
export class CredentialRefreshIndeterminate extends definite("CredentialRefreshIndeterminate") {}
export class CredentialChanged extends definite("CredentialChanged") {}
export class CredentialRotationInvalid extends definite("CredentialRotationInvalid") {}
export class HarnessUnknown extends definite("HarnessUnknown") {}
export class CheckpointHarnessMismatch extends definite("CheckpointHarnessMismatch") {}
export class CheckpointMissing extends definite("CheckpointMissing") {}
export class AssignmentConflict extends definite("AssignmentConflict") {}
export class NetworkPolicyConflict extends definite("NetworkPolicyConflict") {}
export class ArtifactListFailed extends definite("ArtifactListFailed") {}
export class ArtifactLimitExceeded extends definite("ArtifactLimitExceeded") {}
export class EnvironmentNotFound extends definite("EnvironmentNotFound") {}
export class EnvironmentNotReady extends definite("EnvironmentNotReady") {}
export class EnvironmentConflict extends definite("EnvironmentConflict") {}
export class EnvironmentSetupIndeterminate extends definite("EnvironmentSetupIndeterminate") {}
export class EnvironmentSetupFailed extends definite("EnvironmentSetupFailed") {}
export class EnvironmentWriteFailed extends definite("EnvironmentWriteFailed") {}
export class EnvironmentListFailed extends definite("EnvironmentListFailed") {}
export class EnvironmentDriverUnavailable extends definite("EnvironmentDriverUnavailable") {}
export class BackupCredentialsMissing extends definite("BackupCredentialsMissing") {}
export class CapabilityBudgetExceeded extends definite("CapabilityBudgetExceeded") {}
export class StoredObjectMissing extends definite("StoredObjectMissing") {}
export class ObjectStorageUnavailable extends definite("ObjectStorageUnavailable") {}
export class UpstreamRedirect extends definite("UpstreamRedirect") {}
export class ModelNotFound extends definite("ModelNotFound") {}
export class ModelProtocolMismatch extends definite("ModelProtocolMismatch") {}
export class ModelInputMissing extends definite("ModelInputMissing") {}
export class ModelInputTooLarge extends definite("ModelInputTooLarge") {}
export class ModelInputUnsupported extends definite("ModelInputUnsupported") {}
export class ModelOutputFailed extends definite("ModelOutputFailed") {}
export class ProgrammaticExecutionFailed extends definite("ProgrammaticExecutionFailed") {}
export class ProgrammaticOutcomeUncertain extends definite("ProgrammaticOutcomeUncertain") {}
export class ProgrammaticInputTooLarge extends definite("ProgrammaticInputTooLarge") {}
export class InvalidRequest extends definite("InvalidRequest") {}
export class InvalidJson extends definite("InvalidJson") {}
export class InvalidTenant extends definite("InvalidTenant") {}
export class Unauthorized extends definite("Unauthorized") {}
export class BodyTooLarge extends definite("BodyTooLarge") {}

// --- Persistence: the failures that cross RPC or stay retryable -----------------------

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

// --- Domain: the failures that cross RPC ----------------------------------------------

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
/** The selected harness, model alias or deployment cannot serve this configuration. */
export class CapabilityUnsupported extends Enveloped<CapabilityUnsupported>()(
  "CapabilityUnsupported",
  { capability: Schema.Literal(...CAPABILITIES), harness: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return CAPABILITY_MESSAGES[this.capability];
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

// --- Runtime protocol: the answers that carry their own code or message ---------------

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

// --- The closed union -----------------------------------------------------------------

/** The failures whose classes are written by hand; the table's own register themselves. */
const HANDWRITTEN = [
  RecordTooLarge,
  RecordNotFound,
  InvalidCursor,
  StorageFailure,
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
  InvalidRuntimeEvent,
  CommandRejected,
  ExecutionMissing,
  RuntimeRejected,
  CheckpointIncompatible,
  TransportFailure,
] as const;
const DOMAIN_CLASSES: readonly (new (...args: never[]) => unknown)[] = [
  ...DEFINITE_CLASSES,
  ...HANDWRITTEN,
];
/** One failure per table row, plus every hand-written class: the closed union. */
type DefiniteError = {
  [K in DefiniteTag]: Cause.YieldableError & { readonly _tag: K } & Readonly<PropsOf<K>>;
}[DefiniteTag];
export type DomainError = DefiniteError | InstanceType<(typeof HANDWRITTEN)[number]>;
export type DomainTag = DomainError["_tag"];
export const isDomainError = (value: unknown): value is DomainError =>
  DOMAIN_CLASSES.some((cls) => value instanceof cls);

// --- Projection: the only place that knows HTTP --------------------------------------

/** Tags whose runtime answer carries its own code; every other tag has a fixed one. */
type DynamicTag = "RuntimeRejected" | "CommandRejected" | "InvalidRuntimeEvent";
type StaticTag = Exclude<DomainTag, DynamicTag>;
const wireOf = <T extends Record<string, DefiniteRow>>(rows: T) =>
  Object.fromEntries(
    Object.entries(rows).map(([tag, [status, code]]) => [tag, [status, code] as const]),
  ) as { readonly [K in keyof T]: readonly [T[K][0], T[K][1]] };
/** Every static tag's wire answer: the table's own rows, then the hand-written classes. */
const WIRE = {
  ...wireOf(DEFINITE),
  RecordTooLarge: [413, "storage_record_too_large"],
  RecordNotFound: [404, "not_found"],
  InvalidCursor: [400, "invalid_cursor"],
  StorageFailure: [500, "internal_error"],
  SessionNotFound: [404, "not_found"],
  InvalidSessionState: [409, "invalid_session_state"],
  IdempotencyConflict: [409, "idempotency_conflict"],
  SessionFailed: [409, "session_failed"],
  TurnCheckpointing: [409, "turn_checkpointing"],
  TurnActive: [409, "active_turn"],
  SteeringUnsupported: [409, "active_turn_not_steerable"],
  UnknownToolCall: [400, "invalid_request_error"],
  ExecutorVersionIncompatible: [503, "executor_version_incompatible"],
  CapabilityUnsupported: [422, "unsupported_capability"],
  ImageLimitExceeded: [413, "image_limit"],
  ExecutionMissing: [404, "execution_missing"],
  CheckpointIncompatible: [409, "invalid_checkpoint"],
  TransportFailure: [500, "internal_error"],
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

/**
 * Why two transports exist. A failure thrown out of a Durable Object RPC method reaches
 * its caller as an ordinary `Error`, and `remoteApiError` recovers its status and code
 * from the wire name `name` carries; that is how about sixty methods answer, and it is
 * enough, because no caller reads a failure's fields after such a hop. What it costs is
 * that the platform records every one of those throws as an uncaught exception of the
 * callee, visible in a tail. The four calls that use the envelope below expect their
 * failure as an ordinary outcome of a retried request: the catalog's reservation and
 * reserve, the fork's source read and a session's submit. They answer with the failure
 * as data, so the callee returns normally, nothing is logged, and the caller's fiber
 * still fails with the decoded instance rather than a projection of it.
 */
/** A plain `ApiError` inside an envelope: its tag, status and code travel as data. */
const ApiErrorSchema = Schema.transform(
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
const isRpcFailure: (value: unknown) => value is RpcFailure = Schema.is(RpcFailure);
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
