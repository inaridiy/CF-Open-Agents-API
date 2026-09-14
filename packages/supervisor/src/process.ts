import type { ChildProcess } from "node:child_process";

import { type Duration, Effect, Option, type Scope } from "effect";

/** A process that exited, was signalled, or never spawned (`pid` stays undefined after a spawn error). */
const gone = (child: ChildProcess) =>
  child.pid === undefined || child.exitCode !== null || child.signalCode !== null;

/** Resolves once the process is gone; immediately if it already is. */
export const awaitExit = (child: ChildProcess): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    if (gone(child)) {
      resume(Effect.void);
      return;
    }
    const done = () => resume(Effect.void);
    child.once("exit", done);
    child.once("error", done);
    return Effect.sync(() => {
      child.off("exit", done);
      child.off("error", done);
    });
  });

/**
 * SIGTERM, then SIGKILL once the grace period elapses; resolves when the process is
 * gone. The one termination policy for every native runtime the supervisor owns.
 */
export const terminate = (
  child: ChildProcess,
  grace: Duration.DurationInput = "3 seconds",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (gone(child)) return;
    child.kill("SIGTERM");
    // Finalizers run uninterruptibly; the wait must opt back in for the timeout to cut it short.
    const exited = yield* Effect.interruptible(awaitExit(child)).pipe(Effect.timeoutOption(grace));
    if (Option.isNone(exited)) {
      child.kill("SIGKILL");
      yield* awaitExit(child);
    }
  });

/** Spawn into the current Scope: closing it terminates the process and waits for its exit. */
export const acquireProcess = <C extends ChildProcess>(
  spawnChild: () => C,
  grace?: Duration.DurationInput,
): Effect.Effect<C, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(spawnChild), (child) => terminate(child, grace));

/** Adopt a process another library spawned; the Scope terminates it like its own. */
export const ownProcess = (
  child: ChildProcess,
  grace?: Duration.DurationInput,
): Effect.Effect<ChildProcess, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.succeed(child), (owned) => terminate(owned, grace));
