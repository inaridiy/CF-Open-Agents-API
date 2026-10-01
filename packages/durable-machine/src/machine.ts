import { Either, ParseResult, Schema } from "effect";

import { CorruptMachineRecord, InvalidTransition } from "./errors.js";

/**
 * A schema a stored value can be decoded with: no services, and an encoded side that
 * `JSON.stringify` keeps (plain objects, arrays, strings, finite numbers, booleans, null).
 */
export type AnySchema = Schema.Schema.AnyNoContext;

/** One state: its data, the resources it holds, and whether it is terminal. */
export interface StateSpec<
  D extends AnySchema = AnySchema,
  H extends string = string,
  T extends boolean = boolean,
> {
  readonly data: D;
  readonly holds: ReadonlyArray<H>;
  readonly terminal: T;
}

/**
 * A live state. `holds` names the resources that exist while the machine is in it; leaving
 * for a state that does not hold one enqueues that resource's release command.
 */
export function state<D extends AnySchema>(data: D): StateSpec<D, never, false>;
export function state<D extends AnySchema, const H extends string>(
  data: D,
  options: { readonly holds: ReadonlyArray<H> },
): StateSpec<D, H, false>;
export function state(
  data: AnySchema,
  options?: { readonly holds: ReadonlyArray<string> },
): StateSpec<AnySchema, string, false> {
  return { data, holds: options?.holds ?? [], terminal: false };
}

/** A terminal state: it takes no events and holds nothing. */
export function terminal<D extends AnySchema>(data: D): StateSpec<D, never, true> {
  return { data, holds: [], terminal: true };
}

/** The vocabulary of a machine. Every value in it is described by a schema. */
export interface Spec {
  readonly name: string;
  readonly states: { readonly [tag: string]: StateSpec };
  /** Event payloads, without `_tag`. */
  readonly events: { readonly [tag: string]: AnySchema };
  /** Command payloads, without `_tag`. */
  readonly commands: { readonly [tag: string]: AnySchema };
  /**
   * What the host observes when it dispatches (the clock, in-memory counters). A
   * transition reads facts instead of the world, so it stays a pure function.
   */
  readonly facts: AnySchema;
}

/** Fixes a spec's literal types. */
export const spec = <const S extends Spec>(value: S): S => value;

export type StateTag<S extends Spec> = keyof S["states"] & string;
export type EventTag<S extends Spec> = keyof S["events"] & string;
export type CommandTag<S extends Spec> = keyof S["commands"] & string;
export type DataOf<S extends Spec, K extends StateTag<S>> = Schema.Schema.Type<
  S["states"][K]["data"]
>;
export type Facts<S extends Spec> = Schema.Schema.Type<S["facts"]>;
export type State<S extends Spec, K extends StateTag<S> = StateTag<S>> =
  K extends StateTag<S> ? { readonly _tag: K; readonly data: DataOf<S, K> } : never;
/** A payload type; an unresolved `any` (a generic spec) stays an object instead of absorbing `_tag`. */
type Payload<T> = 0 extends 1 & T ? { readonly [field: string]: unknown } : T;
export type Event<S extends Spec, K extends EventTag<S> = EventTag<S>> =
  K extends EventTag<S>
    ? { readonly _tag: K } & Payload<Schema.Schema.Type<S["events"][K]>>
    : never;
export type Command<S extends Spec, K extends CommandTag<S> = CommandTag<S>> =
  K extends CommandTag<S>
    ? { readonly _tag: K } & Payload<Schema.Schema.Type<S["commands"][K]>>
    : never;
export type LiveTag<S extends Spec> = {
  [K in StateTag<S>]: S["states"][K]["terminal"] extends true ? never : K;
}[StateTag<S>];
export type Holds<S extends Spec, K extends StateTag<S>> = S["states"][K]["holds"][number];
export type Resource<S extends Spec> = { [K in StateTag<S>]: Holds<S, K> }[StateTag<S>];
/** The states that hold resource `R`. */
export type Holding<S extends Spec, R extends Resource<S>> = {
  [K in StateTag<S>]: R extends Holds<S, K> ? K : never;
}[StateTag<S>];
/** Events a timer can fire: their payload is empty. */
export type TimerEvent<S extends Spec> = {
  [E in EventTag<S>]: object extends Schema.Schema.Type<S["events"][E]> ? E : never;
}[EventTag<S>];

/** What a transition returns: the next state (possibly the same one) and commands to run after commit. */
export type Next<S extends Spec> = {
  [K in StateTag<S>]: { readonly to: K; readonly data: DataOf<S, K> };
}[StateTag<S>] & { readonly commands?: ReadonlyArray<Command<S>> };

/**
 * A transition: synchronous and pure. It runs inside the storage transaction, so it may
 * not wait for anything; a promise does not type-check, and is refused at run time.
 */
export type Transition<S extends Spec, K extends StateTag<S>, E extends EventTag<S>> = (
  data: DataOf<S, K>,
  event: Event<S, E>,
  facts: Facts<S>,
) => Next<S>;

/** Every live state answers every event: a transition, `"ignore"`, or `"reject"`. */
export type Answer<S extends Spec, K extends StateTag<S>, E extends EventTag<S>> =
  | "ignore"
  | "reject"
  | Transition<S, K, E>;

export type Table<S extends Spec> = {
  readonly [K in LiveTag<S>]: { readonly [E in EventTag<S>]: Answer<S, K, E> };
};

/** Deadlines of a state's timers, as epoch milliseconds, derived from its data alone. */
export type Timers<S extends Spec> = {
  readonly [K in LiveTag<S>]?: (data: DataOf<S, K>) => {
    readonly [E in TimerEvent<S>]?: number | undefined;
  };
};

/** How each resource is released, built from the state that held it. */
export type Releases<S extends Spec> = {
  readonly [R in Resource<S>]: (state: State<S, Holding<S, R>>) => Command<S>;
};

export type Implementation<S extends Spec> = {
  readonly initial: State<S, LiveTag<S>>;
  readonly on: Table<S>;
  readonly timers?: Timers<S>;
} & ([Resource<S>] extends [never]
  ? { readonly release?: Record<string, never> }
  : { readonly release: Releases<S> });

/** A command a step enqueues; `release` commands run even after the state moved on. */
export interface Planned<S extends Spec> {
  readonly command: Command<S>;
  readonly release: boolean;
  /** The resource a release command frees. */
  readonly resource?: Resource<S>;
}

export type Step<S extends Spec> =
  | { readonly _tag: "Ignored"; readonly state: State<S> }
  | { readonly _tag: "Rejected"; readonly state: State<S> }
  | {
      readonly _tag: "Moved";
      readonly from: State<S>;
      readonly to: State<S>;
      readonly commands: ReadonlyArray<Planned<S>>;
      /** The state tag changed. */
      readonly entered: boolean;
    };

export interface Due<S extends Spec> {
  readonly event: TimerEvent<S>;
  readonly at: number;
}

/** The JSON-safe form of a state or command, as stored. */
export interface Encoded {
  readonly _tag: string;
  readonly [field: string]: unknown;
}

export interface Machine<S extends Spec> {
  readonly spec: S;
  readonly name: string;
  readonly initial: State<S>;
  /** Resources in release order: the order of the `release` keys. */
  readonly resources: ReadonlyArray<Resource<S>>;
  step(state: State<S>, event: Event<S>, facts: Facts<S>): Step<S>;
  /** The state's timers, earliest first. */
  timers(state: State<S>): ReadonlyArray<Due<S>>;
  holds(tag: StateTag<S>): ReadonlyArray<Resource<S>>;
  isTerminal(tag: StateTag<S>): boolean;
  encodeState(state: State<S>): Encoded;
  decodeState(value: unknown): State<S>;
  encodeCommand(command: Command<S>): Encoded;
  decodeCommand(value: unknown): Command<S>;
}

const formatted = (error: ParseResult.ParseError) =>
  ParseResult.TreeFormatter.formatErrorSync(error);
const isThenable = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";
const own = (record: object, key: string): boolean => Object.hasOwn(record, key);

/**
 * Builds a machine and checks what the types cannot see at run time: a JavaScript caller,
 * a widened spec, or a table assembled dynamically.
 */
export function make<S extends Spec>(
  definition: S,
  implementation: NoInfer<Implementation<S>>,
): Machine<S> {
  const name = definition.name;
  const tags = Object.keys(definition.states);
  const events = Object.keys(definition.events);
  const on = implementation.on as Record<string, Record<string, unknown>>;
  const timers = (implementation.timers ?? {}) as Record<
    string,
    ((data: unknown) => Record<string, number | undefined>) | undefined
  >;
  const release = (implementation.release ?? {}) as Record<string, (state: unknown) => unknown>;
  const fail = (reason: string): never => {
    throw new Error(`durable-machine ${name}: ${reason}`);
  };
  const specOf = (tag: string): StateSpec => definition.states[tag] ?? fail(`unknown state ${tag}`);
  for (const tag of tags) {
    const stateSpec = specOf(tag);
    if (stateSpec.terminal) {
      if (own(on, tag)) fail(`terminal state ${tag} has a transition table`);
      if (stateSpec.holds.length) fail(`terminal state ${tag} holds resources`);
      continue;
    }
    const answers = on[tag] ?? fail(`live state ${tag} has no transition table`);
    for (const event of events)
      if (!own(answers, event)) fail(`live state ${tag} does not answer ${event}`);
    for (const event of Object.keys(answers))
      if (!events.includes(event)) fail(`state ${tag} answers unknown event ${event}`);
    for (const resource of stateSpec.holds)
      if (typeof release[resource] !== "function") fail(`resource ${resource} has no release`);
  }
  for (const tag of Object.keys(on))
    if (!tags.includes(tag)) fail(`table names unknown state ${tag}`);
  const resources = Object.keys(release) as unknown as ReadonlyArray<Resource<S>>;

  const validData = (tag: string, data: unknown): Either.Either<unknown, string> =>
    Schema.validateEither(specOf(tag).data)(data).pipe(Either.mapLeft(formatted));
  const commandSchema = (tag: string): AnySchema =>
    definition.commands[tag] ?? fail(`unknown command ${tag}`);

  const initial = implementation.initial as State<S>;
  if (specOf(initial._tag).terminal) fail("the initial state is terminal");
  const initialData = validData(initial._tag, initial.data);
  if (Either.isLeft(initialData)) fail(`the initial data is invalid: ${initialData.left}`);

  const holds = (tag: string): ReadonlyArray<Resource<S>> => specOf(tag).holds;

  const decodeCommand = (value: unknown): unknown => {
    const corrupt = (reason: string) => new CorruptMachineRecord({ machine: name, reason });
    if (typeof value !== "object" || value === null || !("_tag" in value))
      throw corrupt("not a command record");
    const { _tag, ...payload } = value;
    const tag = String(_tag);
    if (!own(definition.commands, tag)) throw corrupt(`unknown command ${tag}`);
    const decoded = Schema.decodeUnknownEither(commandSchema(tag))(payload);
    if (Either.isLeft(decoded)) throw corrupt(`${tag}: ${formatted(decoded.left)}`);
    const fields: unknown = decoded.right;
    return { ...(fields as object), _tag: tag };
  };

  const machine: Machine<S> = {
    spec: definition,
    name,
    initial,
    resources,
    holds,
    isTerminal: (tag) => specOf(tag).terminal,
    step(current, event, facts) {
      if (specOf(current._tag).terminal) return { _tag: "Ignored", state: current };
      const stateTag: string = current._tag;
      const eventTag = String(event._tag);
      const invalid = (reason: string) =>
        new InvalidTransition({ machine: name, state: stateTag, event: eventTag, reason });
      const answer = on[stateTag]?.[eventTag];
      if (answer === "ignore") return { _tag: "Ignored", state: current };
      if (answer === "reject") return { _tag: "Rejected", state: current };
      if (typeof answer !== "function") throw invalid("no answer for this event");
      const transition = answer as (data: unknown, event: unknown, facts: unknown) => unknown;
      const next = transition(current.data, event, facts);
      if (isThenable(next)) throw invalid("the transition returned a promise");
      const {
        to,
        data,
        commands = [],
      } = next as {
        to: string;
        data: unknown;
        commands?: ReadonlyArray<{ _tag: string }>;
      };
      if (!own(definition.states, to)) throw invalid(`unknown target state ${to}`);
      const checked = validData(to, data);
      if (Either.isLeft(checked)) throw invalid(`invalid data for ${to}: ${checked.left}`);
      const target = { _tag: to, data } as State<S>;
      const kept = holds(to);
      const released = holds(current._tag).filter((resource) => !kept.includes(resource));
      const ordered = resources.filter((resource) => released.includes(resource));
      const planned = [
        ...commands.map((command) => ({ command, release: false })),
        ...ordered.map((resource) => ({
          command: (release[resource] as (state: unknown) => { _tag: string })(current),
          release: true,
          resource,
        })),
      ];
      for (const { command } of planned) {
        if (!own(definition.commands, command._tag))
          throw invalid(`unknown command ${command._tag}`);
        const result = Schema.validateEither(commandSchema(command._tag))(command);
        if (Either.isLeft(result))
          throw invalid(`invalid command ${command._tag}: ${formatted(result.left)}`);
      }
      return {
        _tag: "Moved",
        from: current,
        to: target,
        commands: planned as unknown as ReadonlyArray<Planned<S>>,
        entered: to !== current._tag,
      };
    },
    timers(current) {
      const derive = timers[current._tag];
      if (!derive || specOf(current._tag).terminal) return [];
      return Object.entries(derive(current.data))
        .filter((entry): entry is [string, number] => entry[1] !== undefined)
        .map(([event, at]) => {
          if (!Number.isFinite(at))
            throw new InvalidTransition({
              machine: name,
              state: current._tag,
              event,
              reason: `timer deadline ${at} is not a finite number`,
            });
          return { event: event as TimerEvent<S>, at };
        })
        .sort((left, right) => left.at - right.at);
    },
    encodeState(current) {
      return {
        _tag: current._tag,
        data: Schema.encodeSync(specOf(current._tag).data)(current.data),
      };
    },
    decodeState(value) {
      const corrupt = (reason: string) => new CorruptMachineRecord({ machine: name, reason });
      if (typeof value !== "object" || value === null || !("_tag" in value))
        throw corrupt("not a state record");
      const tag = String(value._tag);
      if (!own(definition.states, tag)) throw corrupt(`unknown state ${tag}`);
      const decoded = Schema.decodeUnknownEither(specOf(tag).data)(
        (value as { data?: unknown }).data,
      );
      if (Either.isLeft(decoded)) throw corrupt(`${tag}: ${formatted(decoded.left)}`);
      const data: unknown = decoded.right;
      return { _tag: tag, data } as State<S>;
    },
    encodeCommand(command) {
      const { _tag, ...payload } = command as { _tag: string };
      return { ...(Schema.encodeSync(commandSchema(_tag))(payload) as object), _tag };
    },
    decodeCommand: decodeCommand as (value: unknown) => Command<S>,
  };
  return machine;
}
