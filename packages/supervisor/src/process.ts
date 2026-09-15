import type { ChildProcess } from "node:child_process";

import { Data, type Duration, Effect, type Scope } from "effect";

import { within } from "./lifecycle.js";

/** A process that exited, was signalled, or never spawned (`pid` stays undefined after a spawn error). */
const gone = (child: ChildProcess) =>
  child.pid === undefined || child.exitCode !== null || child.signalCode !== null;

/**
 * Wait for a process event as an Effect. `listen` attaches listeners that call
 * `settle` once; the listeners are detached when the wait settles or is interrupted,
 * so nothing stays attached to a process that outlives the wait.
 */
const processEvent = <E>(
  child: ChildProcess,
  listen: (settle: (exit: Effect.Effect<void, E>) => void) => () => void,
): Effect.Effect<void, E> =>
  Effect.async<void, E>((resume) => {
    let detach = () => {};
    detach = listen((exit) => {
      detach();
      resume(exit);
    });
    return Effect.sync(detach);
  });

/** Resolves once the process is gone; immediately if it already is. */
export const awaitExit = (child: ChildProcess): Effect.Effect<void> =>
  Effect.suspend(() =>
    gone(child)
      ? Effect.void
      : processEvent<never>(child, (settle) => {
          const done = () => settle(Effect.void);
          child.on("exit", done);
          child.on("error", done);
          return () => {
            child.off("exit", done);
            child.off("error", done);
          };
        }),
  );

/** True once the process is gone on its own before `grace` elapses; false if it is still running. */
export const exitedWithin = (
  child: ChildProcess,
  grace: Duration.DurationInput,
): Effect.Effect<boolean> => within(awaitExit(child), grace);

/** The process exited, or failed to spawn, before it reported readiness. */
export class ProcessGone extends Data.TaggedError("ProcessGone")<{ readonly message: string }> {}
/** The process did not report readiness within its startup bound. */
export class StartupTimeout extends Data.TaggedError("StartupTimeout")<{
  readonly message: string;
}> {}

/**
 * Resolves once `ready` accepts the tail of the process's stdout, and fails when the
 * process is gone or `bound` elapses first. Listeners are removed either way; stdout
 * stays flowing so a chatty process never blocks on a full pipe.
 */
export const awaitReady = (
  child: ChildProcess,
  ready: (tail: string) => boolean,
  bound: Duration.DurationInput,
  name: string,
): Effect.Effect<void, ProcessGone | StartupTimeout> =>
  Effect.suspend(() => {
    const exited = new ProcessGone({ message: `${name} exited during startup` });
    if (gone(child)) return Effect.fail(exited);
    return processEvent<ProcessGone>(child, (settle) => {
      let tail = "";
      const onData = (data: unknown) => {
        tail = (tail + String(data)).slice(-4096);
        if (ready(tail)) settle(Effect.void);
      };
      const onExit = () => settle(exited);
      const onError = (error: Error) =>
        settle(new ProcessGone({ message: `${name} failed to start: ${error.message}` }));
      child.stdout?.on("data", onData);
      child.on("exit", onExit);
      child.on("error", onError);
      return () => {
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
      };
    });
  }).pipe(
    Effect.timeoutFail({
      duration: bound,
      onTimeout: () => new StartupTimeout({ message: `${name} startup timed out` }),
    }),
  );

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
    if (!(yield* exitedWithin(child, grace))) {
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
