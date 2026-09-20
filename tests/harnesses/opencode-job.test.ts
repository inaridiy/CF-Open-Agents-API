import { expect, it } from "vitest";

import {
  type Execution,
  type RuntimeEvent,
  runPromise,
} from "../../packages/agent-api/src/index.js";
import type { NativeOptions } from "../../packages/supervisor/src/job.js";
import {
  OpenCodeTranscript,
  type TranscriptHost,
} from "../../packages/supervisor/src/opencode-transcript.js";
import { OpenCodeJob, type StatusClient } from "../../packages/supervisor/src/opencode.js";

/** The SDK's event type, reached through the transcript so the test needs no SDK dependency. */
type Event = Parameters<OpenCodeTranscript["accept"]>[0];

const execution = (deadline: number): Execution => ({
  sessionId: "sess_opencode_unit",
  turnId: "turn_unit",
  generation: 1,
  harness: "opencode",
  model: "fixture",
  agent: { model: "fixture" },
  input: [],
  checkpoint: null,
  deadline,
  sandbox: false,
});
const options = (diagnostics: string[]): NativeOptions => ({
  directory: "/unused",
  modelBaseUrl: "http://unused.invalid",
  sandboxUrl: "http://unused.invalid",
  supervisorUrl: "http://unused.invalid",
  opencodeBinary: "unused",
  diagnostics: (line) => diagnostics.push(line),
});
/** Exposes the idle wait without a server process. */
class IdleProbe extends OpenCodeJob {
  constructor(deadline: number, diagnostics: string[]) {
    super(execution(deadline), options(diagnostics));
    this.sessionId = "ses_unit";
  }
  probe(client: StatusClient) {
    return runPromise(this.untilIdle(client));
  }
}
const statusClient = (answer: (call: number) => Promise<{ data?: unknown }>) => {
  let calls = 0;
  const client: StatusClient = {
    session: {
      status: () => {
        calls += 1;
        return answer(calls);
      },
    },
  };
  return { client, calls: () => calls };
};

it("a failed status probe reads as busy and is retried, not as idle", async () => {
  const diagnostics: string[] = [];
  const probe = new IdleProbe(Date.now() + 30_000, diagnostics);
  const status = statusClient(async (call) => {
    if (call < 3) throw new Error("ECONNRESET");
    return { data: { ses_unit: { type: "idle" } } };
  });
  const started = Date.now();
  await probe.probe(status.client);
  expect(status.calls()).toBe(3);
  // Two failed probes each waited out the 250 ms retry interval.
  expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  expect(diagnostics.filter((line) => line.startsWith("opencode status:"))).toHaveLength(1);
});

it("probes that keep failing give up at the execution deadline", async () => {
  const probe = new IdleProbe(Date.now() + 600, []);
  const status = statusClient(async () => {
    throw new Error("socket hang up");
  });
  const started = Date.now();
  await probe.probe(status.client);
  expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(status.calls()).toBeGreaterThanOrEqual(2);
});

it("a busy session is polled until the probe reports it idle", async () => {
  const probe = new IdleProbe(Date.now() + 30_000, []);
  const status = statusClient(async (call) => ({
    data: { ses_unit: { type: call < 2 ? "busy" : "idle" } },
  }));
  await probe.probe(status.client);
  expect(status.calls()).toBe(2);
});

/** The feed as OpenCode 1.18.30 shapes it; only the fields the transcript reads are filled. */
const feed = (type: string, properties: Record<string, unknown>) =>
  ({ type, properties }) as unknown as Event;
const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } };
function transcriptHost() {
  const emitted: RuntimeEvent[] = [];
  const answered: string[] = [];
  const echoed: string[] = [];
  let idle = 0;
  const host: TranscriptHost = {
    sessionId: "ses_parent",
    turnId: "turn_unit",
    children: new Map(),
    emit: (event) => emitted.push(event),
    trackTool: () => {},
    answered: (id) => answered.push(id),
    echoed: (token) => echoed.push(token),
    idle: () => {
      idle += 1;
    },
    diagnostics: () => {},
  };
  return { host, emitted, answered, echoed, idle: () => idle };
}

it("defers completed text until its step decides the phase", () => {
  const h = transcriptHost();
  const transcript = new OpenCodeTranscript(h.host);
  const part = (fields: Record<string, unknown>) =>
    feed("message.part.updated", { part: { sessionID: "ses_parent", ...fields } });
  transcript.accept(part({ type: "reasoning", id: "r1", messageID: "m1", text: "hm", time: {} }));
  transcript.accept(
    feed("message.part.delta", {
      sessionID: "ses_parent",
      partID: "r1",
      field: "text",
      delta: "m",
    }),
  );
  transcript.accept(
    part({ type: "text", id: "t1", messageID: "m1", text: "Let me check.", time: { end: 1 } }),
  );
  expect(h.emitted.map((event) => event.type)).toEqual(["reasoning", "reasoning_delta"]);
  transcript.accept(part({ type: "step-finish", id: "s1", messageID: "m1", reason: "tool-calls" }));
  expect(h.emitted.at(-1)).toMatchObject({ type: "text", id: "t1", phase: "commentary" });
  transcript.accept(
    feed("message.part.delta", {
      sessionID: "ses_parent",
      partID: "t2",
      field: "text",
      delta: "Do",
    }),
  );
  expect(h.emitted.at(-1)).toMatchObject({ type: "delta", id: "t2", text: "Do" });
  transcript.accept(
    part({ type: "text", id: "t2", messageID: "m2", text: "Done.", time: { end: 2 } }),
  );
  transcript.accept(
    feed("message.updated", {
      info: {
        role: "assistant",
        id: "m2",
        sessionID: "ses_parent",
        parentID: "u1",
        finish: "stop",
        time: { created: Date.now() + 1 },
        tokens,
      },
    }),
  );
  expect(h.answered).toEqual(["u1"]);
  expect(h.emitted.slice(-2)).toMatchObject([
    { type: "usage", id: "usage:turn_unit", usage: { input_tokens: 14, output_tokens: 7 } },
    { type: "text", id: "t2", text: "Done.", phase: "final_answer" },
  ]);
  // The turn's closing flush announces nothing twice.
  const before = h.emitted.length;
  transcript.flushAll();
  expect(transcript.claim("t2")).toBe(false);
  expect(h.emitted).toHaveLength(before);
  // Another session's parts are not this turn's.
  transcript.accept(
    part({
      type: "text",
      id: "t9",
      messageID: "m9",
      text: "x",
      time: { end: 3 },
      sessionID: "ses_other",
    }),
  );
  transcript.flushAll();
  expect(h.emitted).toHaveLength(before);
});

it("projects child sessions as subagents and closes them on idle", () => {
  const h = transcriptHost();
  const transcript = new OpenCodeTranscript(h.host);
  transcript.accept(
    feed("session.created", {
      info: { id: "ses_child-1", parentID: "ses_parent", title: "helper", time: { created: 1000 } },
    }),
  );
  expect(h.emitted.map((event) => event.type)).toEqual(["subagent", "subagent_turn"]);
  expect(h.emitted[0]).toMatchObject({
    id: "subagent_seschild1",
    name: "helper",
    status: "active",
  });
  transcript.accept(
    feed("message.part.updated", {
      part: {
        sessionID: "ses_child-1",
        type: "text",
        id: "c1",
        messageID: "cm1",
        text: "child",
        time: { end: 1 },
      },
    }),
  );
  transcript.accept(feed("session.idle", { sessionID: "ses_child-1" }));
  expect(h.emitted.slice(2)).toMatchObject([
    { type: "text", id: "c1", phase: "final_answer", subagentId: "subagent_seschild1" },
    { type: "subagent_turn", id: "turn_seschild1", status: "completed" },
    { type: "subagent", id: "subagent_seschild1", status: "closed" },
  ]);
  expect(h.host.children.get("ses_child-1")?.closed).toBe(true);
  transcript.accept(feed("session.idle", { sessionID: "ses_parent" }));
  expect(h.idle()).toBe(1);
  transcript.accept(
    feed("session.updated", { info: { id: "ses_parent", metadata: { cf_sync: "tok" } } }),
  );
  expect(h.echoed).toEqual(["tok"]);
});
