/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

import { decodeEffect, runPromise } from "../../packages/agent-api/src/effect.js";
import {
  ArtifactLimitExceeded,
  ArtifactListFailed,
  AssignmentConflict,
  BodyTooLarge,
  CapabilityBudgetExceeded,
  CapabilityUnsupported,
  caughtFailure,
  CheckpointHarnessMismatch,
  CheckpointIncompatible,
  CheckpointMissing,
  CommandRejected,
  ContainerUnassigned,
  CredentialAmbiguous,
  CredentialChanged,
  CredentialExpired,
  CredentialNotFound,
  CredentialRefreshFailed,
  CredentialRefreshIndeterminate,
  CredentialRefreshRejected,
  CredentialRotationInvalid,
  DelegateUnavailable,
  type DomainError,
  type DomainTag,
  EnvironmentConflict,
  BackupCredentialsMissing,
  EnvironmentDriverUnavailable,
  EnvironmentListFailed,
  EnvironmentNotFound,
  EnvironmentNotReady,
  EnvironmentSetupFailed,
  EnvironmentSetupIndeterminate,
  EnvironmentWriteFailed,
  ExecutionMissing,
  ExecutorVersionIncompatible,
  FileExpired,
  FileTooLarge,
  HarnessUnknown,
  IdempotencyConflict,
  ImageLimitExceeded,
  InputFileInvalid,
  InvalidCursor,
  InvalidJson,
  InvalidRequest,
  InvalidRuntimeEvent,
  InvalidSessionState,
  InvalidTenant,
  isDomainError,
  isPermanent,
  McpPlacementInvalid,
  McpTransportUnsupported,
  ModelInputMissing,
  ModelInputTooLarge,
  ModelInputUnsupported,
  ModelNotFound,
  ModelNotRegistered,
  ModelOutputFailed,
  ModelUpstreamRejected,
  ModelProtocolMismatch,
  NetworkPolicyBroadened,
  NetworkPolicyConflict,
  ObjectStorageUnavailable,
  ProgrammaticExecutionFailed,
  ProgrammaticInputTooLarge,
  ProgrammaticOutcomeUncertain,
  RecordNotFound,
  RecordTooLarge,
  ReservedToolName,
  RuntimeRejected,
  SessionFailed,
  SessionNotDeleted,
  SessionNotFound,
  SkillFileMissing,
  SkillIntegrityMismatch,
  SkillInvalid,
  SkillManifestMissing,
  SkillMissing,
  SkillPathInvalid,
  SkillTooLarge,
  SkillVersionIsDefault,
  SteeringUnsupported,
  StorageFailure,
  StoredObjectMissing,
  StreamLimitExceeded,
  SubagentTurnMismatch,
  Superseded,
  toApiError,
  TransportFailure,
  TurnActive,
  TurnCheckpointing,
  Unauthorized,
  UnknownToolCall,
  UpstreamRedirect,
} from "../../packages/agent-api/src/errors.js";
import {
  ApiError,
  pageSchema,
  parseEffect,
  remoteApiError,
} from "../../packages/agent-api/src/protocol.js";
import type * as WorkerModule from "./worker.js";
import type { TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}

/**
 * One sample per tag, keyed by the closed union: a class added without a row here, or
 * a row whose tag no longer exists, fails to type-check. Each row carries the wire
 * projection the HTTP envelope and the RPC wire name must keep.
 */
const samples: { readonly [K in DomainTag]: [Extract<DomainError, { _tag: K }>, number, string] } =
  {
    RecordTooLarge: [new RecordTooLarge({ bytes: 2_000_000 }), 413, "storage_record_too_large"],
    RecordNotFound: [new RecordNotFound({ kind: "turn", id: "turn_x" }), 404, "not_found"],
    InvalidCursor: [new InvalidCursor(), 400, "invalid_cursor"],
    StorageFailure: [
      new StorageFailure({ operation: "session.tx", cause: null }),
      500,
      "internal_error",
    ],
    SessionNotFound: [new SessionNotFound(), 404, "not_found"],
    InvalidSessionState: [
      new InvalidSessionState({ reason: "Inconsistent" }),
      409,
      "invalid_session_state",
    ],
    Superseded: [new Superseded({ turnId: "turn_x", generation: 1 }), 409, "stale_generation"],
    ContainerUnassigned: [new ContainerUnassigned(), 409, "unassigned_container"],
    IdempotencyConflict: [
      new IdempotencyConflict({ subject: "input" }),
      409,
      "idempotency_conflict",
    ],
    SessionFailed: [new SessionFailed(), 409, "session_failed"],
    TurnCheckpointing: [new TurnCheckpointing(), 409, "turn_checkpointing"],
    TurnActive: [new TurnActive({ action: "delete" }), 409, "active_turn"],
    SessionNotDeleted: [new SessionNotDeleted(), 409, "not_deleted"],
    SteeringUnsupported: [
      new SteeringUnsupported({ harness: "codex" }),
      409,
      "active_turn_not_steerable",
    ],
    UnknownToolCall: [new UnknownToolCall({ callId: "c" }), 400, "invalid_request_error"],
    ExecutorVersionIncompatible: [
      new ExecutorVersionIncompatible({ harness: "codex", revision: "1" }),
      503,
      "executor_version_incompatible",
    ],
    StreamLimitExceeded: [new StreamLimitExceeded({ limit: 64 }), 429, "stream_limit"],
    SubagentTurnMismatch: [
      new SubagentTurnMismatch({ subagentId: "subagent_x", turnId: "turn_x" }),
      404,
      "not_found",
    ],
    CapabilityUnsupported: [
      new CapabilityUnsupported({ capability: "image_input" }),
      422,
      "unsupported_capability",
    ],
    ModelNotRegistered: [new ModelNotRegistered({ alias: "x" }), 422, "unsupported_model"],
    DelegateUnavailable: [new DelegateUnavailable({ alias: "x" }), 503, "delegate_unavailable"],
    ReservedToolName: [new ReservedToolName(), 400, "invalid_request"],
    McpPlacementInvalid: [
      new McpPlacementInvalid({ rule: "environment_required" }),
      400,
      "invalid_request",
    ],
    McpTransportUnsupported: [
      new McpTransportUnsupported({ transport: "stdio" }),
      400,
      "invalid_request",
    ],
    NetworkPolicyBroadened: [
      new NetworkPolicyBroadened({ rule: "access" }),
      400,
      "network_policy_broadened",
    ],
    ImageLimitExceeded: [
      new ImageLimitExceeded({ limit: 256, scope: "request" }),
      413,
      "image_limit",
    ],
    InputFileInvalid: [new InputFileInvalid(), 400, "invalid_file"],
    FileTooLarge: [new FileTooLarge({ kind: "input" }), 413, "file_too_large"],
    FileExpired: [new FileExpired({ id: "file_x" }), 404, "not_found"],
    SkillInvalid: [new SkillInvalid({ reason: "Missing SKILL.md" }), 400, "invalid_skill"],
    SkillTooLarge: [new SkillTooLarge({ limit: "upload" }), 413, "skill_too_large"],
    SkillVersionIsDefault: [
      new SkillVersionIsDefault({ version: "1" }),
      409,
      "default_skill_version",
    ],
    SkillPathInvalid: [new SkillPathInvalid({ path: "../x" }), 400, "invalid_skill_path"],
    SkillManifestMissing: [new SkillManifestMissing(), 400, "missing_skill"],
    SkillMissing: [new SkillMissing({ reason: "bundle" }), 404, "skill_missing"],
    SkillFileMissing: [new SkillFileMissing({ path: "x" }), 404, "skill_file_missing"],
    SkillIntegrityMismatch: [new SkillIntegrityMismatch(), 409, "skill_integrity"],
    CredentialAmbiguous: [
      new CredentialAmbiguous({ reason: "multiple_matches" }),
      400,
      "ambiguous_credential",
    ],
    CredentialNotFound: [new CredentialNotFound(), 404, "not_found"],
    CredentialExpired: [new CredentialExpired({ reason: "expired" }), 422, "credential_expired"],
    CredentialRefreshRejected: [
      new CredentialRefreshRejected(),
      422,
      "credential_refresh_rejected",
    ],
    CredentialRefreshFailed: [
      new CredentialRefreshFailed({ reason: "unknown" }),
      422,
      "credential_refresh_failed",
    ],
    CredentialRefreshIndeterminate: [new CredentialRefreshIndeterminate(), 409, "outcome_unknown"],
    CredentialChanged: [new CredentialChanged(), 409, "credential_changed"],
    CredentialRotationInvalid: [
      new CredentialRotationInvalid({ rule: "auth_type" }),
      400,
      "invalid_request",
    ],
    InvalidRuntimeEvent: [
      new InvalidRuntimeEvent({ code: "invalid_runtime_cursor", message: "Gap" }),
      409,
      "invalid_runtime_cursor",
    ],
    CommandRejected: [
      new CommandRejected({ code: "command_rejected", message: "Refused" }),
      409,
      "command_rejected",
    ],
    ExecutionMissing: [new ExecutionMissing({ message: "Gone" }), 404, "execution_missing"],
    RuntimeRejected: [
      new RuntimeRejected({ status: 422, code: "unsupported_capability", message: "No" }),
      422,
      "unsupported_capability",
    ],
    CheckpointIncompatible: [
      new CheckpointIncompatible({ message: "Revision" }),
      409,
      "invalid_checkpoint",
    ],
    TransportFailure: [
      new TransportFailure({ operation: "runtime.poll", cause: null }),
      500,
      "internal_error",
    ],
    HarnessUnknown: [new HarnessUnknown({ harness: "x" }), 400, "unsupported_harness"],
    CheckpointHarnessMismatch: [
      new CheckpointHarnessMismatch({ harness: "codex", revision: "0" }),
      409,
      "checkpoint_incompatible",
    ],
    CheckpointMissing: [new CheckpointMissing({ key: "k" }), 409, "checkpoint_missing"],
    AssignmentConflict: [
      new AssignmentConflict({ sessionId: "sess_x" }),
      409,
      "assignment_conflict",
    ],
    NetworkPolicyConflict: [new NetworkPolicyConflict(), 409, "network_policy_conflict"],
    ArtifactListFailed: [new ArtifactListFailed(), 503, "artifact_list_failed"],
    ArtifactLimitExceeded: [new ArtifactLimitExceeded(), 413, "artifact_limit"],
    EnvironmentNotFound: [new EnvironmentNotFound({ environmentId: "env_x" }), 404, "not_found"],
    EnvironmentNotReady: [
      new EnvironmentNotReady({ reason: "upload" }),
      409,
      "environment_not_ready",
    ],
    EnvironmentConflict: [
      new EnvironmentConflict({ environmentId: "env_x" }),
      409,
      "environment_conflict",
    ],
    EnvironmentSetupIndeterminate: [new EnvironmentSetupIndeterminate(), 409, "outcome_unknown"],
    EnvironmentSetupFailed: [
      new EnvironmentSetupFailed({ reason: "command" }),
      422,
      "environment_setup_failed",
    ],
    EnvironmentWriteFailed: [
      new EnvironmentWriteFailed({ reason: "file" }),
      503,
      "environment_write_failed",
    ],
    EnvironmentListFailed: [new EnvironmentListFailed(), 503, "environment_list_failed"],
    BackupCredentialsMissing: [
      new BackupCredentialsMissing({ missing: ["R2_ACCESS_KEY_ID"] }),
      503,
      "environment_unavailable",
    ],
    EnvironmentDriverUnavailable: [
      new EnvironmentDriverUnavailable(),
      503,
      "environment_unavailable",
    ],
    CapabilityBudgetExceeded: [new CapabilityBudgetExceeded(), 413, "capability_limit"],
    StoredObjectMissing: [new StoredObjectMissing({ object: "input_file" }), 404, "not_found"],
    ObjectStorageUnavailable: [new ObjectStorageUnavailable(), 503, "storage_unavailable"],
    UpstreamRedirect: [
      new UpstreamRedirect({ operation: "mcp.request" }),
      503,
      "upstream_redirect",
    ],
    ModelNotFound: [new ModelNotFound({ model: "x" }), 404, "model_not_found"],
    ModelProtocolMismatch: [
      new ModelProtocolMismatch({ protocol: "responses" }),
      400,
      "model_protocol_mismatch",
    ],
    ModelInputMissing: [new ModelInputMissing(), 400, "missing_model_input"],
    ModelInputTooLarge: [new ModelInputTooLarge(), 413, "model_input_too_large"],
    ModelInputUnsupported: [new ModelInputUnsupported(), 400, "unsupported_model_input"],
    ModelOutputFailed: [new ModelOutputFailed(), 503, "model_output_failed"],
    ModelUpstreamRejected: [new ModelUpstreamRejected(), 503, "model_upstream_rejected"],
    ProgrammaticExecutionFailed: [
      new ProgrammaticExecutionFailed({ reason: "Timed out" }),
      422,
      "programmatic_execution_failed",
    ],
    ProgrammaticOutcomeUncertain: [
      new ProgrammaticOutcomeUncertain({ reason: "Lost" }),
      422,
      "programmatic_execution_uncertain",
    ],
    ProgrammaticInputTooLarge: [
      new ProgrammaticInputTooLarge(),
      413,
      "programmatic_input_too_large",
    ],
    InvalidRequest: [new InvalidRequest({ issues: "✖ Expected string" }), 400, "invalid_request"],
    InvalidJson: [new InvalidJson(), 400, "invalid_json"],
    InvalidTenant: [new InvalidTenant(), 400, "invalid_tenant"],
    Unauthorized: [new Unauthorized(), 401, "unauthorized"],
    BodyTooLarge: [new BodyTooLarge(), 413, "body_too_large"],
  };
const RETRYABLE = new Set<DomainTag>(["TransportFailure", "StorageFailure"]);
const PERMANENT = new Set<DomainTag>([
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
]);

it("every tag of every layer projects to exactly one (status, code) and keeps its wire name", () => {
  for (const [error, status, code] of Object.values(samples)) {
    expect(isDomainError(error)).toBe(true);
    const projected = toApiError(error);
    expect(projected).toBeInstanceOf(ApiError);
    expect(projected).toMatchObject({ status, code, message: error.message });
    // Only a definite answer carries the wire name; a retryable failure never looks like one.
    const retryable = RETRYABLE.has(error._tag);
    expect(error.name.startsWith("AgentApiError:")).toBe(!retryable);
    expect(remoteApiError(error)?.code).toBe(retryable ? undefined : code);
    // The permanence policy is a predicate over tags; a wire-name arrival matches by code.
    expect(isPermanent(error)).toBe(PERMANENT.has(error._tag));
    expect(isPermanent(projected)).toBe(PERMANENT.has(error._tag));
    expect(caughtFailure(error)).toBe(error);
    expect(caughtFailure(Object.assign(new Error(error.message), { name: error.name }))).toEqual(
      retryable ? undefined : projected,
    );
  }
});

it("derived messages stay byte-identical to the envelope the SDK has always seen", () => {
  expect(new RecordNotFound({ kind: "turn", id: "turn_x" }).message).toBe("turn not found");
  expect(new TurnActive({ action: "delete" }).message).toBe(
    "Cancel the active turn before deleting the session",
  );
  expect(new TurnActive({ action: "fork" }).message).toBe(
    "Wait for the current turn to stop before forking",
  );
  expect(new IdempotencyConflict({ subject: "agent parameters" }).message).toBe(
    "Key was used with different agent parameters",
  );
  expect(
    new IdempotencyConflict({ subject: "skill upload", reason: "Skill upload reservation changed" })
      .message,
  ).toBe("Skill upload reservation changed");
  expect(new InvalidCursor({ reason: "Cursor does not belong to this listing" }).message).toBe(
    "Cursor does not belong to this listing",
  );
  expect(new CapabilityUnsupported({ capability: "web_search" }).message).toBe(
    "The selected harness or model alias does not support web search",
  );
  expect(new ImageLimitExceeded({ limit: 256, scope: "turn" }).message).toBe(
    "A turn may reference at most 256 remote images",
  );
  expect(new DelegateUnavailable({ alias: "helper" }).message).toBe(
    "Delegate preset helper is not registered in this deployment",
  );
});

it("parseEffect and decodeEffect fail with InvalidRequest instead of throwing", async () => {
  const zod = await runPromise(Effect.flip(parseEffect(pageSchema, { limit: 0 })));
  expect(zod).toBeInstanceOf(InvalidRequest);
  expect(zod.name).toBe("AgentApiError:400:invalid_request");
  expect(zod.message).toContain("Too small");
  expect(await runPromise(parseEffect(pageSchema, { limit: "5" }))).toMatchObject({ limit: 5 });
  const schema = await runPromise(
    Effect.flip(decodeEffect(Schema.Struct({ n: Schema.Number }), {})),
  );
  expect(schema).toBeInstanceOf(InvalidRequest);
});

const tenant = "errors";
const api = new OpenAI({
  apiKey: tenant,
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const raw = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(
    new Request(`https://api.test${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tenant}`,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    }),
  );
afterEach(() => reset());

it("routes answer with the same envelope for every layer's failure", async () => {
  const envelope = async (response: Response) => ({
    status: response.status,
    retry: response.headers.get("x-should-retry"),
    body: await response.json(),
  });
  // Persistence: a record the catalog never stored, named by its kind.
  expect(await envelope(await raw("/v1/files/file_missing"))).toEqual({
    status: 404,
    retry: null,
    body: {
      error: {
        message: "input_file not found",
        type: "invalid_request_error",
        code: "not_found",
        param: null,
      },
    },
  });
  // Domain: a session the tenant does not own.
  expect(await envelope(await raw("/v1/agents/sessions/sess_missing"))).toEqual({
    status: 404,
    retry: null,
    body: {
      error: {
        message: "Session not found",
        type: "invalid_request_error",
        code: "not_found",
        param: null,
      },
    },
  });
  // Domain: a model the deployment does not register.
  expect(
    await envelope(
      await raw("/v1/agents/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { model: "unregistered" }, environment: { type: "none" } }),
      }),
    ),
  ).toEqual({
    status: 422,
    retry: null,
    body: {
      error: {
        message: "Model is not registered in this deployment",
        type: "invalid_request_error",
        code: "unsupported_model",
        param: null,
      },
    },
  });
  // Domain, permanent: deleting a session whose turn is still running.
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test" },
    environment: { type: "none" },
    input: "hold",
  });
  expect(
    await envelope(await raw(`/v1/agents/sessions/${session.id}`, { method: "DELETE" })),
  ).toEqual({
    status: 409,
    retry: "false",
    body: {
      error: {
        message: "Cancel the active turn before deleting the session",
        type: "invalid_request_error",
        code: "active_turn",
        param: null,
      },
    },
  });
  // Wire: a missing credential and a body that is not JSON.
  expect(
    await envelope(await exports.default.fetch(new Request("https://api.test/v1/agents"))),
  ).toEqual({
    status: 401,
    retry: null,
    body: {
      error: {
        message: "Authentication required",
        type: "authentication_error",
        code: "unauthorized",
        param: null,
      },
    },
  });
  expect(
    await envelope(
      await raw("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    ),
  ).toEqual({
    status: 400,
    retry: null,
    body: {
      error: {
        message: "Request body must be valid JSON",
        type: "invalid_request_error",
        code: "invalid_json",
        param: null,
      },
    },
  });
});
