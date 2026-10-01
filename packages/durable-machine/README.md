# durable-machine

Typed, durable state machines for Cloudflare Durable Objects, built on [Effect](https://effect.website).

A Durable Object that owns something outside itself (a container, a lease, a job on another service) keeps re-learning the same lessons: a transition applied to a record read before an `await`, a state that forgets to answer an event, a resource left running on one exit path, a timer lost when the object is evicted, I/O started inside a storage transaction. `durable-machine` turns each of those into something the compiler or the runtime refuses:

| Bug                                            | How it is prevented                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A state does not answer an event               | The transition table has a required entry for every event in every live state: a transition, `"ignore"` or `"reject"`. A missing one does not compile.   |
| An event changes a finished machine            | Terminal states take no table entry and hold nothing; the runtime ignores events in them.                                                                |
| A transition does I/O inside the transaction   | A transition is a synchronous function `(data, event, facts) => next`; an `async` one does not compile and a returned promise is refused at run time.    |
| Invalid data or commands are stored            | States, events, commands and facts are Effect Schemas; every transition result is validated before it is written.                                        |
| A resource leaks on one exit path              | A state declares the resources it `holds`. Leaving it for a state that does not hold one enqueues that resource's release command, in a fixed order.     |
| A late result of old work overwrites new state | Commands run after commit from an outbox. Their result events carry the epoch of the state that issued them and are dropped once the state has moved on. |
| A timer is lost when the object is evicted     | Timers are a pure function of the state's data; the next deadline is recomputed from storage and set as the object's single alarm in the same write.     |

## A machine

```ts
import { Schema } from "effect";
import { Machine } from "durable-machine";

const Lease = Machine.spec({
  name: "container",
  facts: Schema.Struct({ now: Schema.Number, busy: Schema.Number }),
  events: {
    need: Schema.Struct({}),
    idle: Schema.Struct({}),
    retire: Schema.Struct({}),
  },
  commands: { boot: Schema.Struct({}), destroy: Schema.Struct({}) },
  states: {
    stopped: Machine.state(Schema.Struct({})),
    running: Machine.state(Schema.Struct({ lastActive: Schema.Number }), {
      holds: ["container"],
    }),
    retired: Machine.terminal(Schema.Struct({})),
  },
});

export const lease = Machine.make(Lease, {
  initial: { _tag: "stopped", data: {} },
  on: {
    stopped: {
      need: (_data, _event, facts) => ({
        to: "running",
        data: { lastActive: facts.now },
        commands: [{ _tag: "boot" }],
      }),
      idle: "ignore",
      retire: () => ({ to: "retired", data: {} }),
    },
    running: {
      need: (_data, _event, facts) => ({ to: "running", data: { lastActive: facts.now } }),
      idle: (data, _event, facts) =>
        facts.busy > 0 || facts.now < data.lastActive + 600_000
          ? { to: "running", data }
          : { to: "stopped", data: {} },
      retire: () => ({ to: "retired", data: {} }),
    },
  },
  timers: { running: (data) => ({ idle: data.lastActive + 600_000 }) },
  // Every way out of `running` destroys the container; nothing in the table says so.
  release: { container: () => ({ _tag: "destroy" }) },
});
```

`facts` are what the host observes when it dispatches (the clock, an in-memory request count); a transition reads them instead of the world, so it stays a pure function and tests are deterministic. `Machine.make` also checks the table at run time, for JavaScript callers and tables built dynamically.

## In a Durable Object

```ts
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { DurableMachine, sqliteStore } from "durable-machine";

export class ContainerOwner extends DurableObject {
  private busy = 0;
  private readonly machine = DurableMachine.make({
    machine: lease,
    store: sqliteStore(this.ctx.storage),
    facts: () => ({ now: Date.now(), busy: this.busy }),
    // Called right after each commit, without an await in between, so the alarm is
    // written together with the transaction.
    arm: (at) =>
      void (at === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(at)),
    handlers: {
      boot: () => Effect.promise(() => this.startContainer()),
      destroy: () => Effect.promise(() => this.ctx.container!.destroy()),
    },
  });
  use() {
    return Effect.runPromise(this.machine.send({ _tag: "need" }));
  }
  override alarm() {
    return Effect.runPromise(this.machine.wake);
  }
}
```

- `apply(event, alongside?)` commits one transition in one `transactionSync`, together with the host's own writes in `alongside`; a throw in either rolls both back.
- `send(event)` applies and then `drain`s: pending commands run in order, after commit, at least once, with a stable id per command for idempotency. A failure is retried with backoff and blocks the commands behind it, so releases keep their order. A command enqueued by a request that is evicted before it runs is picked up by the alarm.
- A command whose state moved on before it ran is dropped, except a release, which always runs. A result event from an older epoch (the epoch advances when the state tag changes) is dropped.
- `wake` is the alarm entry: it fires due timers (each deadline once) and drains.
- `memoryStore()` gives the same transaction semantics without a Durable Object, for tests.

## Checking a machine

`durable-machine/check` drives random event sequences, generated from the schemas with `effect/FastCheck`, through the machine from the initial state or from any state, and fails with a shrunk counterexample when a transition throws, produces data or commands its schemas refuse, leaves a held resource without its release, derives an invalid timer, does not survive a JSON round trip of its stored form, or breaks your invariant:

```ts
import { explore, gaps, mermaid } from "durable-machine/check";

const coverage = explore(job, {
  from: "initial",
  invariant: (step) =>
    step._tag === "Moved" && step.from._tag === "cancelling" && step.to._tag === "completed"
      ? "a cancelled job completed"
      : undefined,
});
gaps(job, coverage); // states and (state, event) pairs never exercised
mermaid(job, coverage); // a state diagram of what was explored
```

The package's own tests use it to find, from the initial state, a cancellation race this repository once shipped (a task that settled during cancellation recorded as completed).

## Scope

- Effect 3.22 or later in the 3.x line (`peerDependencies`).
- One machine per key in a store; several machines can share one object's storage with different `key`s, but they share its single alarm only if the host combines their `nextWake()`.
- Platform behaviour outside the object (a response body that keeps a container awake, an SDK's own timers) is out of reach of any state machine; the host still has to know its platform.
- `cf-open-agents-api` runs both of its container objects on this package (`src/containers/lease.ts`).

Apache-2.0.
