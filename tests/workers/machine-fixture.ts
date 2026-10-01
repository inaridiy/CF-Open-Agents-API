import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";

import { DurableMachine, sqliteStore } from "../../packages/durable-machine/src/index.js";
import { lease } from "../../packages/durable-machine/test/fixture.js";

/**
 * The durable-machine fixture over real Durable Object SQLite: the lease machine with its
 * commands logged to storage, the clock held in storage so tests can move it, and the
 * object's alarm armed by the machine.
 */
export class MachineFixture extends DurableObject {
  private readonly store = sqliteStore(this.ctx.storage);
  private now = (): number => this.ctx.storage.kv.get<number>("now") ?? Date.now();
  private readonly machine = DurableMachine.make({
    machine: lease,
    store: this.store,
    clock: () => this.now(),
    facts: () => ({ now: this.now(), busy: 0 }),
    arm: (at) => {
      if (at === null) void this.ctx.storage.deleteAlarm();
      else void this.ctx.storage.setAlarm(at);
    },
    handlers: {
      start: (command) =>
        Effect.sync(() => {
          this.logLine(`start ${command.generation}`);
          return { _tag: "started" as const };
        }),
      stopContainer: (command) =>
        Effect.sync(() => this.logLine(`stopContainer ${command.reason}`)),
      dropSandbox: () => Effect.sync(() => this.logLine("dropSandbox")),
    },
  });
  private logLine(line: string): undefined {
    this.ctx.storage.kv.put("log", [...(this.ctx.storage.kv.get<string[]>("log") ?? []), line]);
    return undefined;
  }
  setNow(now: number): void {
    this.ctx.storage.kv.put("now", now);
  }
  async send(event: Parameters<typeof this.machine.apply>[0]): Promise<string> {
    const step = await Effect.runPromise(Effect.either(this.machine.send(event)));
    return step._tag === "Left" ? step.left._tag : step.right._tag;
  }
  /** Applies an event and a host write that throws, in one transaction. */
  failingWrite(): string {
    try {
      this.machine.apply({ _tag: "acquire", generation: 9 }, () => {
        this.ctx.storage.kv.put("host", "written");
        throw new Error("host write failed");
      });
      return "applied";
    } catch {
      return "rolled back";
    }
  }
  inspect() {
    return {
      state: this.machine.current(),
      epoch: this.machine.epoch(),
      log: this.ctx.storage.kv.get<string[]>("log") ?? [],
      host: this.ctx.storage.kv.get<string>("host") ?? null,
      outbox: this.store.outbox("lease").length,
      nextWake: this.machine.nextWake(),
    };
  }
  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
  override async alarm(): Promise<void> {
    await Effect.runPromise(this.machine.wake);
  }
}
