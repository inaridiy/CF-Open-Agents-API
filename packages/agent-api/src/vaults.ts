import { Data, Effect, Schema } from "effect";
import type { Credential } from "openai/resources/beta/agents/vaults/credentials";
import type { Vault } from "openai/resources/beta/agents/vaults/vaults";
import { z } from "zod";

import { attempt, io } from "./effect.js";
import { requestWithoutRedirect } from "./http.js";
import {
  ApiError,
  canonicalJSON,
  identifier,
  metadataSchema,
  pageSchema,
  parse,
} from "./protocol.js";
import type { SqlStore } from "./storage.js";

const secret = z.string().min(1).max(128_000);
const httpsURL = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "Expected an HTTPS URL without user information or fragment");
const authMethod = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("client_secret_basic"), client_secret: secret }),
  z.strictObject({ type: z.literal("client_secret_post"), client_secret: secret }),
]);
const refreshSchema = z.strictObject({
  client_id: z.string().min(1),
  refresh_token: secret,
  token_endpoint: httpsURL,
  token_endpoint_auth: authMethod,
  resource: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
});
export const credentialAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("static_bearer"), mcp_server_url: httpsURL, token: secret }),
  z.strictObject({
    type: z.literal("mcp_oauth"),
    mcp_server_url: httpsURL,
    access_token: secret,
    expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
    refresh: refreshSchema.nullable().optional(),
  }),
]);
export const credentialSchema = z.strictObject({
  name: z.string().min(1).max(256),
  auth: credentialAuthSchema,
});
export const rotateCredentialSchema = z.strictObject({
  auth: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("static_bearer"), token: secret }),
    z.strictObject({
      type: z.literal("mcp_oauth"),
      access_token: secret.nullable().optional(),
      expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
      refresh: z
        .strictObject({
          refresh_token: secret.nullable().optional(),
          scope: z.string().nullable().optional(),
          token_endpoint_auth: z
            .strictObject({
              type: z.enum(["client_secret_basic", "client_secret_post"]),
              client_secret: secret.nullable().optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    }),
  ]),
});
export const vaultSchema = z.strictObject({
  name: z.string().max(256).optional(),
  metadata: metadataSchema,
});
export const vaultPageSchema = pageSchema.extend({
  status: z
    .union([z.enum(["active", "archived"]), z.array(z.enum(["active", "archived"]))])
    .optional(),
});
type Auth = z.infer<typeof credentialAuthSchema>;
type CredentialRecord = { version: 1; resource: Credential; auth: Auth };
/** The token endpoint answered: the refresh token was not consumed by a lost request. */
class RefreshRejected extends Data.TaggedError("RefreshRejected")<{
  readonly status: number;
  /** A 4xx answer: the grant itself is invalid and only rotation can help. */
  readonly rejected: boolean;
}> {}

export function publicCredentialAuth(auth: Auth): Credential["auth"] {
  if (auth.type === "static_bearer")
    return { type: auth.type, mcp_server_url: auth.mcp_server_url };
  return {
    type: auth.type,
    mcp_server_url: auth.mcp_server_url,
    expires_at: auth.expires_at ?? null,
    refresh: auth.refresh
      ? {
          client_id: auth.refresh.client_id,
          resource: auth.refresh.resource ?? null,
          scope: auth.refresh.scope ?? null,
          token_endpoint: auth.refresh.token_endpoint,
          token_endpoint_auth: { type: auth.refresh.token_endpoint_auth.type },
        }
      : null,
  };
}

const formComponent = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);

/** Tenant-owned catalog storage. Secrets are never returned through public resource methods. */
export class VaultRepository {
  private readonly refreshGate = Effect.unsafeMakeSemaphore(1);
  constructor(
    private readonly db: SqlStore,
    private readonly send: (request: Request) => Promise<Response> = fetch,
  ) {}
  private matching(
    vaultIds: readonly string[],
    url: string,
    credentialId?: string | null,
  ): CredentialRecord | undefined {
    const matches: CredentialRecord[] = [];
    for (const vaultId of new Set(vaultIds)) {
      this.retrieve(vaultId);
      let after: string | undefined;
      do {
        const page = this.db.list<CredentialRecord>(`credential:${vaultId}`, {
          order: "asc",
          limit: 100,
          after,
        });
        for (const credential of page.data)
          if (
            (!credentialId || credential.resource.id === credentialId) &&
            new URL(credential.auth.mcp_server_url).href === new URL(url).href
          )
            matches.push(credential);
        after = page.has_more ? (page.last_id ?? undefined) : undefined;
      } while (after);
    }
    if (matches.length > 1)
      throw new ApiError(400, "ambiguous_credential", "Select one matching MCP credential");
    if (!matches[0] && credentialId)
      throw new ApiError(404, "not_found", "Matching attached credential not found");
    return matches[0];
  }
  private usableToken(record: CredentialRecord): string | undefined {
    const auth = record.auth;
    if (auth.type === "static_bearer") return auth.token;
    if (this.db.get("credential_refresh_rejected", record.resource.id))
      throw new ApiError(
        422,
        "credential_refresh_rejected",
        "The token endpoint rejected the OAuth refresh; rotate the credential",
      );
    if (!auth.expires_at || Date.parse(auth.expires_at) > Date.now() + 30_000)
      return auth.access_token;
    if (!auth.refresh) {
      if (Date.parse(auth.expires_at) > Date.now()) return auth.access_token;
      throw new ApiError(
        422,
        "credential_expired",
        "MCP credential expired; rotate the credential",
      );
    }
    return undefined;
  }
  token(vaultIds: readonly string[], url: string, credentialId?: string | null) {
    return Effect.gen(this, function* () {
      const record = yield* attempt("vault.match", () =>
        this.matching(vaultIds, url, credentialId),
      );
      if (!record) return undefined;
      const token = yield* attempt("vault.expiry", () => this.usableToken(record));
      if (token !== undefined) return token;
      return yield* this.refreshGate.withPermits(1)(
        Effect.gen(this, function* () {
          // A concurrent refresh or rotation may have completed while acquiring the gate.
          const current = yield* attempt("vault.reload", () =>
            this.db.require<CredentialRecord>(
              `credential:${record.resource.vault_id}`,
              record.resource.id,
            ),
          );
          const renewed = yield* attempt("vault.expiry", () => this.usableToken(current));
          return renewed ?? (yield* this.refresh(current));
        }),
      );
    });
  }
  private refresh(record: CredentialRecord) {
    return Effect.gen(this, function* () {
      const auth = record.auth;
      if (auth.type !== "mcp_oauth" || !auth.refresh)
        return yield* new ApiError(
          422,
          "credential_expired",
          "Missing OAuth refresh configuration",
        );
      const id = record.resource.id;
      const fingerprint = canonicalJSON(auth);
      const operationId = identifier("refresh");
      yield* attempt("vault.refresh.reserve", () =>
        this.db.transaction(() => {
          if (this.db.get("credential_refresh", id))
            throw new ApiError(
              409,
              "outcome_unknown",
              "OAuth refresh outcome is unknown; rotate the credential",
            );
          this.db.put("credential_refresh", id, { version: 1, fingerprint, operationId });
        }),
      );
      const refresh = auth.refresh;
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh.refresh_token,
        client_id: refresh.client_id,
      });
      if (refresh.resource) body.set("resource", refresh.resource);
      if (refresh.scope) body.set("scope", refresh.scope);
      const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
      if (refresh.token_endpoint_auth.type === "client_secret_basic")
        headers.set(
          "authorization",
          `Basic ${btoa(`${formComponent(refresh.client_id)}:${formComponent(refresh.token_endpoint_auth.client_secret)}`)}`,
        );
      if (refresh.token_endpoint_auth.type === "client_secret_post")
        body.set("client_secret", refresh.token_endpoint_auth.client_secret);
      const tokenSchema = Schema.Struct({
        access_token: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128000)),
        token_type: Schema.String.pipe(Schema.filter((value) => value.toLowerCase() === "bearer")),
        expires_in: Schema.optional(Schema.Number.pipe(Schema.positive(), Schema.finite())),
        refresh_token: Schema.optional(
          Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128000)),
        ),
        scope: Schema.optional(Schema.String),
      });
      const exchange = Effect.scoped(
        Effect.gen(this, function* () {
          // Acquire the cancellation handle synchronously. The network request itself
          // remains interruptible, including when the server never sends headers.
          const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          const response = yield* requestWithoutRedirect(
            "vault.refresh.request",
            new Request(refresh.token_endpoint, {
              method: "POST",
              headers,
              body,
              signal: controller.signal,
            }),
            this.send,
          );
          yield* Effect.addFinalizer(() =>
            io("vault.refresh.release", () => response.body?.cancel() ?? Promise.resolve()).pipe(
              Effect.ignore,
            ),
          );
          if (!response.ok)
            return yield* new RefreshRejected({
              status: response.status,
              rejected: response.status >= 400 && response.status < 500,
            });
          // A 2xx body that cannot be decoded may still have rotated the token: unknown.
          return yield* io("vault.refresh.body", () => response.json()).pipe(
            Effect.flatMap((value) => Schema.decodeUnknown(tokenSchema)(value)),
            Effect.mapError(
              () =>
                new ApiError(422, "credential_refresh_failed", "Invalid OAuth refresh response"),
            ),
          );
        }),
      ).pipe(
        Effect.timeoutFail({
          duration: "30 seconds",
          onTimeout: () =>
            new ApiError(422, "credential_refresh_failed", "OAuth refresh timed out"),
        }),
      );
      const outcome = yield* exchange.pipe(Effect.either);
      if (outcome._tag === "Left") {
        const failure = outcome.left;
        // The endpoint answered (or refused a redirect before any credential was sent):
        // nothing was consumed, so the reservation is released. A 4xx grant rejection is
        // final until rotation; a 5xx may be retried. No answer at all stays unknown.
        const definite =
          failure instanceof RefreshRejected ||
          (failure instanceof ApiError && failure.code === "upstream_redirect");
        if (definite) {
          const rejected = failure instanceof RefreshRejected && failure.rejected;
          yield* attempt("vault.refresh.release", () =>
            this.db.transaction(() => {
              if (
                this.db.get<{ operationId: string }>("credential_refresh", id)?.operationId ===
                operationId
              )
                this.db.remove("credential_refresh", id);
              if (rejected)
                this.db.put("credential_refresh_rejected", id, {
                  version: 1,
                  status: failure.status,
                  at: Math.floor(Date.now() / 1000),
                });
            }),
          );
          return yield* new ApiError(
            422,
            rejected ? "credential_refresh_rejected" : "credential_refresh_failed",
            rejected
              ? "The token endpoint rejected the OAuth refresh; rotate the credential"
              : "The token endpoint failed; retry later",
          );
        }
        return yield* new ApiError(
          422,
          "credential_refresh_failed",
          "OAuth refresh outcome is unknown; rotate the credential before retrying",
        );
      }
      const result = outcome.right;
      return yield* attempt("vault.refresh.commit", () =>
        this.db.transaction(() => {
          const current = this.db.require<CredentialRecord>(
            `credential:${record.resource.vault_id}`,
            id,
          );
          if (
            canonicalJSON(current.auth) !== fingerprint ||
            this.db.get<{ operationId: string }>("credential_refresh", id)?.operationId !==
              operationId
          )
            throw new ApiError(409, "credential_changed", "Credential was rotated during refresh");
          const updated: Auth = {
            ...auth,
            access_token: result.access_token,
            expires_at: result.expires_in
              ? new Date(Date.now() + result.expires_in * 1000).toISOString()
              : null,
            refresh: {
              ...refresh,
              refresh_token: result.refresh_token ?? refresh.refresh_token,
              scope: result.scope ?? refresh.scope,
            },
          };
          this.db.put(`credential:${record.resource.vault_id}`, id, {
            ...record,
            auth: updated,
            resource: {
              ...record.resource,
              auth: publicCredentialAuth(updated),
              updated_at: Math.floor(Date.now() / 1000),
            },
          });
          this.db.remove("credential_refresh", id);
          return updated.access_token;
        }),
      );
    });
  }
  create(parameters: z.infer<typeof vaultSchema>): Vault {
    const input = parse(vaultSchema, parameters);
    const resource: Vault = {
      id: identifier("vault"),
      object: "vault",
      created_at: Math.floor(Date.now() / 1000),
      name: input.name ?? null,
      metadata: input.metadata ?? {},
    };
    this.db.put("vault", resource.id, { version: 1, resource });
    return resource;
  }
  retrieve(id: string): Vault {
    return this.db.require<{ version: 1; resource: Vault }>("vault", id).resource;
  }
  list(parameters: z.infer<typeof vaultPageSchema>) {
    const input = parse(vaultPageSchema, parameters);
    const statuses = input.status === undefined ? ["active"] : [input.status].flat();
    // Deleted resources and their secrets are removed, so this deployment has no archived rows.
    const page = this.db.list<{ resource: Vault }>("vault", input);
    return {
      ...page,
      ...(statuses.includes("active")
        ? { data: page.data.map(({ resource }) => resource) }
        : { data: [], has_more: false, first_id: null, last_id: null }),
    };
  }
  delete(id: string) {
    return this.db.transaction(() => {
      this.retrieve(id);
      this.db.clear(`credential:${id}`);
      this.db.remove("vault", id);
      return { id, object: "vault.deleted" as const, deleted: true };
    });
  }
  createCredential(vaultId: string, parameters: z.infer<typeof credentialSchema>): Credential {
    this.retrieve(vaultId);
    const input = parse(credentialSchema, parameters);
    const now = Math.floor(Date.now() / 1000);
    const resource: Credential = {
      id: identifier("cred"),
      object: "vault.credential",
      vault_id: vaultId,
      name: input.name,
      created_at: now,
      updated_at: now,
      auth: publicCredentialAuth(input.auth),
    };
    this.db.put(`credential:${vaultId}`, resource.id, {
      version: 1,
      resource,
      auth: input.auth,
    } satisfies CredentialRecord);
    return resource;
  }
  credential(vaultId: string, id: string): Credential {
    this.retrieve(vaultId);
    return this.db.require<CredentialRecord>(`credential:${vaultId}`, id).resource;
  }
  credentials(vaultId: string, parameters: z.infer<typeof vaultPageSchema>) {
    this.retrieve(vaultId);
    const input = parse(vaultPageSchema, parameters);
    const page = this.db.list<CredentialRecord>(`credential:${vaultId}`, input);
    const statuses = input.status === undefined ? ["active"] : [input.status].flat();
    return {
      ...page,
      ...(statuses.includes("active")
        ? { data: page.data.map(({ resource }) => resource) }
        : { data: [], has_more: false, first_id: null, last_id: null }),
    };
  }
  rotate(
    vaultId: string,
    id: string,
    parameters: z.infer<typeof rotateCredentialSchema>,
  ): Credential {
    return this.db.transaction(() => {
      this.retrieve(vaultId);
      const update = parse(rotateCredentialSchema, parameters).auth;
      const record = this.db.require<CredentialRecord>(`credential:${vaultId}`, id);
      const auth = record.auth;
      if (auth.type !== update.type)
        throw new ApiError(400, "invalid_request", "Credential authentication type cannot change");
      if (auth.type === "static_bearer" && update.type === "static_bearer")
        auth.token = update.token;
      if (auth.type === "mcp_oauth" && update.type === "mcp_oauth") {
        if (update.access_token != null) {
          auth.access_token = update.access_token;
          auth.expires_at = null;
        }
        if (update.expires_at !== undefined) auth.expires_at = update.expires_at;
        if (update.refresh) {
          if (!auth.refresh)
            throw new ApiError(400, "invalid_request", "Credential has no refresh configuration");
          if (update.refresh.refresh_token != null)
            auth.refresh.refresh_token = update.refresh.refresh_token;
          if (update.refresh.scope !== undefined) auth.refresh.scope = update.refresh.scope;
          const replacement = update.refresh.token_endpoint_auth;
          if (replacement) {
            if (auth.refresh.token_endpoint_auth.type !== replacement.type)
              throw new ApiError(
                400,
                "invalid_request",
                "OAuth authentication method cannot change",
              );
            if (replacement.client_secret != null)
              auth.refresh.token_endpoint_auth = {
                type: replacement.type,
                client_secret: replacement.client_secret,
              };
          }
        }
      }
      record.resource.auth = publicCredentialAuth(auth);
      record.resource.updated_at = Math.floor(Date.now() / 1000);
      this.db.put(`credential:${vaultId}`, id, record);
      this.db.remove("credential_refresh", id);
      this.db.remove("credential_refresh_rejected", id);
      return record.resource;
    });
  }
  deleteCredential(vaultId: string, id: string) {
    this.credential(vaultId, id);
    this.db.remove(`credential:${vaultId}`, id);
    this.db.remove("credential_refresh", id);
    this.db.remove("credential_refresh_rejected", id);
    return { id, object: "vault.credential.deleted" as const, deleted: true };
  }
}
