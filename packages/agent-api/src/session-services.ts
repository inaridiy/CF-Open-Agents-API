import { Clock, Context, Effect, Layer, ManagedRuntime, Option } from "effect";

import { StorageFailure } from "./errors.js";
import type { SessionRepo } from "./persistence/session-repo.js";
import type { AgentRegistration, RuntimeDriver } from "./runtime.js";

/** What a deployment configures for every session object; see `createAgentService`. */
export interface SessionDependencies {
  drivers: Record<string, RuntimeDriver>;
  /** Deployment presets, used to resolve delegation targets when subagents are enabled. */
  agents?: Record<string, AgentRegistration>;
  maxTurnMs: number;
  pollIntervalMs: number;
  /** Interval of SSE keepalive comments while live streams exist. */
  keepaliveMs?: number;
}

/**
 * The three services a session program needs, and the only ones a test substitutes.
 * Time comes from Effect's own `Clock`. Everything else a program touches is a plain
 * argument.
 */
export class Drivers extends Context.Tag("agent-api/Drivers")<
  Drivers,
  {
    readonly get: (name: string) => Option.Option<RuntimeDriver>;
    readonly agents: Record<string, AgentRegistration>;
    readonly maxTurnMs: number;
    readonly pollIntervalMs: number;
    readonly keepaliveMs: number;
  }
>() {}
export class Alarm extends Context.Tag("agent-api/Alarm")<
  Alarm,
  {
    /** Wake the object `inMs` from now; the platform keeps one alarm, so this replaces it. */
    readonly arm: (inMs: number) => Effect.Effect<void, StorageFailure>;
    readonly clear: Effect.Effect<void, StorageFailure>;
  }
>() {}
export class Repo extends Context.Tag("agent-api/SessionRepo")<Repo, SessionRepo>() {}
export type SessionServices = Drivers | Alarm | Repo;

/**
 * Configuration is read through `provider` on every access, never captured: a deployment
 * resolves its harnesses per call today, and a test replaces `dependencies()` on a live
 * object between two entrypoints.
 */
export const driversFrom = (provider: () => SessionDependencies): Context.Tag.Service<Drivers> => ({
  get: (name) => Option.fromNullable(provider().drivers[name]),
  get agents() {
    return provider().agents ?? {};
  },
  get maxTurnMs() {
    return provider().maxTurnMs;
  },
  get pollIntervalMs() {
    return provider().pollIntervalMs;
  },
  get keepaliveMs() {
    return provider().keepaliveMs ?? 15_000;
  },
});

/** Durable Object alarms take no signal; interrupting the fiber orphans the platform call. */
export const alarmFromStorage = (storage: DurableObjectStorage): Context.Tag.Service<Alarm> => ({
  arm: (inMs) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.tryPromise({
          try: () => storage.setAlarm(now + inMs),
          catch: (cause) => new StorageFailure({ operation: "session.arm", cause }),
        }),
      ),
    ),
  clear: Effect.tryPromise({
    try: () => storage.deleteAlarm(),
    catch: (cause) => new StorageFailure({ operation: "session.disarm", cause }),
  }),
});

/**
 * One runtime per object, built once and shared by every entrypoint. The layers hold no
 * resources, so an evicted object leaks nothing by never disposing it.
 */
export const makeSessionRuntime = (services: {
  readonly repo: SessionRepo;
  readonly alarm: Context.Tag.Service<Alarm>;
  readonly drivers: Context.Tag.Service<Drivers>;
}): ManagedRuntime.ManagedRuntime<SessionServices, never> =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(Repo, services.repo),
      Layer.succeed(Alarm, services.alarm),
      Layer.succeed(Drivers, services.drivers),
    ),
  );
