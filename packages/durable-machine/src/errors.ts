import { Data } from "effect";

/**
 * The transition table answers this event with `"reject"`. A definite answer, not a fault:
 * the caller asked for something the current state does not allow.
 */
export class EventRejected extends Data.TaggedError("EventRejected")<{
  readonly machine: string;
  readonly state: string;
  readonly event: string;
}> {
  override get message(): string {
    return `${this.machine}: ${this.state} rejects ${this.event}`;
  }
}

/**
 * A transition function broke the machine's own contract: it returned a state the schema
 * refuses, named an unknown state, built a command the schema refuses, or returned a
 * promise. A programming error; inside a transaction it rolls the transition back.
 */
export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly machine: string;
  readonly state: string;
  readonly event: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.machine}: ${this.state} on ${this.event}: ${this.reason}`;
  }
}

/** The stored state or a stored command no longer decodes with the machine's schemas. */
export class CorruptMachineRecord extends Data.TaggedError("CorruptMachineRecord")<{
  readonly machine: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.machine}: stored record does not decode: ${this.reason}`;
  }
}
