import type { Effect } from "effect";
import type { EnvironmentInfo } from "openai/resources/beta/agents/environments/environments";
import type { EnvironmentFile } from "openai/resources/beta/agents/environments/files";
import { z } from "zod";

import type { ServiceError } from "./effect.js";
import type { EnvironmentFileInput, HostedConfiguration } from "./environment-config.js";
import { NetworkPolicyBroadened } from "./errors.js";
import type { ResolvedInputFile } from "./files.js";
import type { ResolvedSkill } from "./skills.js";

export interface EnvironmentSpec {
  id: string;
  sessionId: string;
  configuration: string;
  inputFiles?: Record<string, ResolvedInputFile>;
  skills?: ResolvedSkill[];
  /**
   * Set by a fork: `prepare` adopts the source environment's committed workspace
   * and capability roots instead of running setup again. `workspace` is the
   * source session's last completed checkpoint when one exists.
   */
  inherited?: {
    sessionId: string;
    environmentId: string;
    workspace?: { id: string; dir: string; localBucket?: boolean };
  };
}
export const environmentFilePageSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.string().optional(),
  path: z.string().nullable().optional(),
});
export interface EnvironmentDriver {
  prepare(spec: EnvironmentSpec): Effect.Effect<void, ServiceError>;
  status(spec: EnvironmentSpec): Effect.Effect<EnvironmentInfo["status"], ServiceError>;
  upload(
    spec: EnvironmentSpec,
    input: EnvironmentFileInput,
  ): Effect.Effect<EnvironmentFile, ServiceError>;
  files(
    spec: EnvironmentSpec,
    query: z.infer<typeof environmentFilePageSchema>,
  ): Effect.Effect<
    { object: "list"; data: EnvironmentFile[]; has_more: boolean; next: string | null },
    ServiceError
  >;
}
export function mergeEnvironment(
  template: HostedConfiguration,
  inline: HostedConfiguration,
): HostedConfiguration {
  const result = { ...template, ...inline };
  const base = template.network;
  const next = result.network;
  if (base && base.access !== "enabled") {
    if (
      !next ||
      (base.access === "disabled" && next.access !== "disabled") ||
      next.access === "enabled"
    )
      throw new NetworkPolicyBroadened({ rule: "access" });
    if (base.access === "restricted" && next.access === "restricted") {
      const allowed = base.allowed_domains ?? [];
      for (const domain of next.allowed_domains ?? []) {
        if (
          !allowed.some(
            (entry) =>
              entry === domain || (entry.startsWith("*.") && domain.endsWith(entry.slice(1))),
          )
        )
          throw new NetworkPolicyBroadened({ rule: "domains" });
      }
    }
  }
  return result;
}
