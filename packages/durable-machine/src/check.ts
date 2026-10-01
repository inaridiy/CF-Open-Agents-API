import { Arbitrary, FastCheck, type Schema } from "effect";

import type { Event, Facts, Machine, Spec, State, StateTag, Step } from "./machine.js";

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly events: ReadonlySet<string>;
  readonly count: number;
}

/** What an exploration exercised. */
export interface Coverage {
  /** Steps taken in each state. */
  readonly states: ReadonlyMap<string, number>;
  /** Observed state changes, keyed `from -> to`. */
  readonly edges: ReadonlyMap<string, Edge>;
  /** How each (state, event) pair was answered, keyed `state/event`. */
  readonly answers: ReadonlyMap<string, ReadonlySet<Step<Spec>["_tag"]>>;
}

export interface ExploreOptions<S extends Spec> {
  /** Property runs; default 300. */
  readonly runs?: number;
  /** Events per run; default 25. */
  readonly depth?: number;
  readonly seed?: number;
  /**
   * Where runs start: `"any"` (default) draws any state from the state schemas, so every
   * state is exercised even when no event sequence reaches it from the initial one;
   * `"initial"` replays reachable behaviour only.
   */
  readonly from?: "any" | "initial";
  readonly events?: FastCheck.Arbitrary<Event<S>>;
  readonly facts?: FastCheck.Arbitrary<Facts<S>>;
  readonly states?: FastCheck.Arbitrary<State<S>>;
  /** A property of every step; return a description of the violation, or `undefined`. */
  readonly invariant?: (step: Step<S>, event: Event<S>, facts: Facts<S>) => string | undefined;
}

const tagged = <A>(tag: string, schema: Schema.Schema<A, unknown>) =>
  Arbitrary.make(schema).map((value) => ({ ...(value as object), _tag: tag }));

/** Event, fact and state arbitraries derived from the machine's schemas. */
export function arbitraries<S extends Spec>(machine: Machine<S>) {
  const { spec } = machine;
  const events = FastCheck.oneof(
    ...Object.entries(spec.events).map(([tag, schema]) => tagged(tag, schema)),
  ) as unknown as FastCheck.Arbitrary<Event<S>>;
  const facts = Arbitrary.make(spec.facts) as FastCheck.Arbitrary<Facts<S>>;
  const states = FastCheck.oneof(
    ...Object.entries(spec.states).map(([tag, definition]) =>
      Arbitrary.make(definition.data).map((data: unknown) => ({ _tag: tag, data })),
    ),
  ) as unknown as FastCheck.Arbitrary<State<S>>;
  return { events, facts, states };
}

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/**
 * Drives random event sequences through the machine and fails with a shrunk
 * counterexample when a transition throws, returns data or commands its schemas refuse,
 * leaves a held resource without its release, derives an invalid timer, does not survive
 * a JSON round trip of its stored form, or breaks `invariant`. Returns what it covered.
 */
export function explore<S extends Spec>(
  machine: Machine<S>,
  options: ExploreOptions<S> = {},
): Coverage {
  const derived = arbitraries(machine);
  const events = options.events ?? derived.events;
  const facts = options.facts ?? derived.facts;
  const start =
    options.from === "initial"
      ? FastCheck.constant(machine.initial)
      : FastCheck.oneof(FastCheck.constant(machine.initial), options.states ?? derived.states);
  const states = new Map<string, number>();
  const edges = new Map<string, Edge>();
  const answers = new Map<string, Set<Step<Spec>["_tag"]>>();
  const record = (state: State<S>, event: Event<S>, step: Step<S>) => {
    states.set(state._tag, (states.get(state._tag) ?? 0) + 1);
    const pair = `${state._tag}/${event._tag}`;
    answers.set(pair, (answers.get(pair) ?? new Set()).add(step._tag));
    if (step._tag !== "Moved" || !step.entered) return;
    const key = `${step.from._tag} -> ${step.to._tag}`;
    const edge = edges.get(key);
    edges.set(key, {
      from: step.from._tag,
      to: step.to._tag,
      events: new Set([...(edge?.events ?? []), event._tag]),
      count: (edge?.count ?? 0) + 1,
    });
  };
  const persistable = (state: State<S>) => {
    const encoded = machine.encodeState(state);
    const again = machine.encodeState(machine.decodeState(roundTrip(encoded)));
    if (JSON.stringify(again) !== JSON.stringify(encoded))
      throw new Error(`state ${state._tag} does not survive a JSON round trip`);
  };
  FastCheck.assert(
    FastCheck.property(
      start,
      FastCheck.array(FastCheck.tuple(events, facts), { maxLength: options.depth ?? 25 }),
      (initial, sequence) => {
        let current = initial;
        machine.timers(current);
        for (const [event, observed] of sequence) {
          const step = machine.step(current, event, observed);
          record(current, event, step);
          if (step._tag === "Moved") {
            const kept = machine.holds(step.to._tag);
            for (const resource of machine.holds(step.from._tag)) {
              if (kept.includes(resource)) continue;
              const released = step.commands.some(
                (planned) => planned.release && planned.resource === resource,
              );
              if (!released)
                throw new Error(
                  `${step.from._tag} -> ${step.to._tag} leaves ${resource} without a release`,
                );
            }
            for (const planned of step.commands) {
              const encoded = machine.encodeCommand(planned.command);
              machine.decodeCommand(roundTrip(encoded));
            }
            persistable(step.to);
            machine.timers(step.to);
            current = step.to;
          }
          const violation = options.invariant?.(step, event, observed);
          if (violation) throw new Error(violation);
        }
      },
    ),
    { numRuns: options.runs ?? 300, ...(options.seed === undefined ? {} : { seed: options.seed }) },
  );
  return { states, edges, answers };
}

/** A Mermaid state diagram: every state, the initial one, terminals, and the explored edges. */
export function mermaid<S extends Spec>(machine: Machine<S>, coverage?: Coverage): string {
  const lines = ["stateDiagram-v2", `  [*] --> ${machine.initial._tag}`];
  for (const tag of Object.keys(machine.spec.states) as StateTag<S>[]) {
    const holds = machine.holds(tag);
    if (holds.length) lines.push(`  ${tag}: ${tag} (holds ${holds.join(", ")})`);
    if (machine.isTerminal(tag)) lines.push(`  ${tag} --> [*]`);
  }
  for (const edge of coverage?.edges.values() ?? [])
    lines.push(`  ${edge.from} --> ${edge.to}: ${[...edge.events].sort().join(", ")}`);
  return lines.join("\n");
}

/** States and (state, event) pairs that an exploration never exercised. */
export function gaps<S extends Spec>(machine: Machine<S>, coverage: Coverage) {
  const live = (Object.keys(machine.spec.states) as StateTag<S>[]).filter(
    (tag) => !machine.isTerminal(tag),
  );
  return {
    states: live.filter((tag) => !coverage.states.has(tag)),
    pairs: live.flatMap((tag) =>
      Object.keys(machine.spec.events)
        .map((event) => `${tag}/${event}`)
        .filter((pair) => !coverage.answers.has(pair)),
    ),
  };
}
