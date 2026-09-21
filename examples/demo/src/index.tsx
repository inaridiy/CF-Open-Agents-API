import { type AgentRPC, tenantFetch } from "cf-open-agents-api/cloudflare";
import { zipSync } from "fflate";
import { type Context, Hono } from "hono";
import { stream } from "hono/streaming";
import OpenAI from "openai";

import {
  closeText,
  type Entry,
  EntryView,
  ErrorPage,
  escape,
  Home,
  Job,
  type JobState,
  LiveEnd,
  livePage,
  openText,
  render,
  SUMMARY_SEPARATOR,
  zipFits,
} from "./ui.js";

interface Bindings {
  /** Self Service Binding to this Worker's `Agents` entrypoint (see wrangler.jsonc). */
  AGENTS: Fetcher & AgentRPC;
}

type Session = OpenAI.Beta.Agents.AgentSession;
type SessionEvent = OpenAI.Beta.Agents.AgentSessionEvent;
type Item = OpenAI.Beta.Agents.AgentSessionItem;
type Artifact = OpenAI.Beta.Agents.Sessions.SessionArtifact;
type Subagent = OpenAI.Beta.Agents.Subagent;

/**
 * The tenant every session of this app belongs to. A Service Binding caller names the
 * tenant itself (`fetchAs`), so no API token travels over the binding; `bearerTenant` in
 * src/agents.ts maps HTTP callers with the token to the same tenant.
 */
const TENANT = "default";

const INSTRUCTIONS = `You are building a small deliverable for the user.
Write every file the user should receive under /workspace/outputs (create the directory first); only files there are delivered.
Keep it self-contained and finish in one go. When done, reply with a short summary of what you built and how to use it.`;

const OUTPUTS = "/workspace/outputs/";

/** A text form field; file uploads are ignored. */
const field = (value: FormDataEntryValue | null) => (typeof value === "string" ? value.trim() : "");

/**
 * The official OpenAI client, pointed at the Service Binding instead of the network.
 * `agents.internal` is a routing label; the request never leaves this Worker. The SDK
 * insists on an API key, but the API never reads it here: the binding is the credential.
 */
function agentClient(env: Bindings): OpenAI {
  return new OpenAI({
    apiKey: "service-binding",
    baseURL: "https://agents.internal/v1",
    fetch: tenantFetch(env.AGENTS, TENANT),
  });
}

/** A `/cf/v1` extension route (no SDK method), served as the tenant over the binding. */
const cf = (env: Bindings, path: string) =>
  env.AGENTS.fetchAs(TENANT, new Request(`https://agents.internal/cf/v1${path}`));

/** The preset names `agents` in src/agents.ts defines, read from the deployment itself. */
async function presetNames(env: Bindings): Promise<string[]> {
  const response = await cf(env, "/capabilities");
  if (!response.ok) throw new Error(`Capabilities request failed with ${response.status}`);
  const { agents } = await response.json<{ agents: Record<string, unknown> }>();
  return Object.keys(agents);
}

const running = (session: Session) => session.status === "in_progress";

async function collect<T>(page: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of page) out.push(item);
  return out;
}

// --- The event log ----------------------------------------------------------------------

/**
 * What one event changed. A renderable change is an `Entry`: the same value the fold keeps
 * for the committed page and the live page appends as a fragment. Text deltas are written
 * into the open block instead, and `settled` ends the stream.
 */
type Change =
  | Entry
  | { kind: "text"; id: string; owner: Subagent | null; label: string; cls: string; text: string }
  | { kind: "settled" };

type ItemEntry = Extract<Entry, { kind: "item" }>;

/** Where an event's items are tracked and, for a delegated child, whose they are. */
interface Owner {
  subagent: Subagent | null;
  items: Map<string, ItemEntry>;
}

/**
 * A fold over the session's event log, and the only source of a transcript here. The same
 * reducer builds a settled page and the committed head of a running one from
 * `GET /cf/v1/sessions/:id/events?after=<seq>`, then applies the live stream on top, so a
 * page loaded at any moment shows exactly what the log holds and continues from there.
 */
class Transcript {
  session: Session;
  /** Every renderable change in log order; the live page appends these same values. */
  private readonly entries: Entry[] = [];
  private readonly root: Owner = { subagent: null, items: new Map() };
  private readonly subagents = new Map<string, Owner>();
  /** Turn id → subagent id: an item's turn tells whose transcript it belongs to. */
  private readonly turns = new Map<string, string | null>();
  /** The last sequence number applied; live frames at or below it are duplicates. */
  seq = 0;
  /** Set by `replayInto` when the log was too long to fold in full; see `REPLAY_PAGE_CAP`. */
  truncated = false;

  constructor(session: Session) {
    this.session = session;
  }

  get running(): boolean {
    return running(this.session);
  }

  /** Artifacts are published by the checkpoint, not by the log, so they are passed in. */
  state(artifacts: Artifact[] = []): JobState {
    return {
      session: this.session,
      entries: this.entries,
      artifacts,
      running: this.running,
      truncated: this.truncated,
    };
  }

  /** The transcript an item of `turnId` belongs to: a delegated child's, or the root's. */
  private owner(turnId: string | null): Owner {
    const subagentId = turnId ? this.turns.get(turnId) : null;
    return (subagentId ? this.subagents.get(subagentId) : undefined) ?? this.root;
  }

  /** Keep a renderable change in log order and hand it to the live page. */
  private push<T extends Entry>(entry: T): T {
    this.entries.push(entry);
    return entry;
  }

  apply(event: SessionEvent): Change | null {
    switch (event.type) {
      case "agent.session.created":
      case "agent.session.in_progress":
        this.session = event.session;
        return null;
      case "agent.session.idle":
      case "agent.session.failed":
      case "agent.session.requires_action":
        this.session = event.session;
        return { kind: "settled" };
      case "agent.session.subagent.created":
      case "agent.session.subagent.active":
      case "agent.session.subagent.closed":
        return this.applySubagent(event.subagent, event.type !== "agent.session.subagent.active");
      case "agent.session.turn.created":
      case "agent.session.turn.in_progress":
      case "agent.session.turn.completed":
      case "agent.session.turn.cancelled":
        this.turns.set(event.turn.id, event.turn.subagent_id);
        return null;
      case "agent.session.turn.failed":
        this.turns.set(event.turn.id, event.turn.subagent_id);
        return event.turn.error ? this.push({ kind: "turn_failed", turn: event.turn }) : null;
      case "agent.session.turn.item.added":
        return this.applyItem(this.owner(event.turn_id), event.item, false);
      case "agent.session.turn.item.done":
        return this.applyItem(this.owner(event.turn_id), event.item, true);
      case "agent.session.turn.output_text.delta":
        return this.applyText(this.owner(event.turn_id), event.item_id, event.delta);
      case "agent.session.turn.reasoning_summary_text.delta":
        return this.applyReasoning(
          this.owner(event.turn_id),
          event.item_id,
          event.summary_index,
          event.delta,
        );
      default:
        return null;
    }
  }

  private applySubagent(subagent: Subagent, announce: boolean): Change | null {
    const owner = this.subagents.get(subagent.id);
    if (owner) owner.subagent = subagent;
    else this.subagents.set(subagent.id, { subagent, items: new Map() });
    return announce ? this.push({ kind: "subagent", subagent }) : null;
  }

  private applyItem(owner: Owner, item: Item, done: boolean): Change | null {
    const known = item.id ? owner.items.get(item.id) : undefined;
    if (known) {
      // `item.done` carries the finished item; it replaces the one the deltas wrote into.
      if (done) known.item = item;
      return done ? known : null;
    }
    // An item with no id cannot be matched later, so it joins the transcript once, at done.
    if (!(item.id || done)) return null;
    const entry = this.push({ kind: "item" as const, item, owner: owner.subagent });
    if (item.id) owner.items.set(item.id, entry);
    return done ? entry : null;
  }

  private applyText(owner: Owner, itemId: string, delta: string): Change | null {
    const item = owner.items.get(itemId)?.item;
    if (item?.type !== "message") return null;
    const part = item.content[0];
    if (part?.type === "output_text") part.text += delta;
    const label = item.phase ?? "assistant";
    return {
      kind: "text",
      id: itemId,
      owner: owner.subagent,
      label,
      cls: `assistant ${label}`,
      text: delta,
    };
  }

  private applyReasoning(
    owner: Owner,
    itemId: string,
    index: number,
    delta: string,
  ): Change | null {
    const item = owner.items.get(itemId)?.item;
    if (item?.type !== "reasoning") return null;
    // Both the live block and the finished item (`summaryText` in ui.tsx) join summary parts
    // with SUMMARY_SEPARATOR; diffing the joined string before and after this delta, instead
    // of guessing whether it starts a new part, keeps the two in step even when a part is
    // skipped or stays empty.
    const before = item.summary.map((p) => p.text).join(SUMMARY_SEPARATOR);
    while (item.summary.length <= index) item.summary.push({ type: "summary_text", text: "" });
    const part = item.summary[index];
    if (part) part.text += delta;
    const after = item.summary.map((p) => p.text).join(SUMMARY_SEPARATOR);
    return {
      kind: "text",
      id: itemId,
      owner: owner.subagent,
      label: "thinking",
      cls: "reasoning",
      text: after.slice(before.length),
    };
  }
}

/** The library's maximum rows per page, and how many pages one replay will fetch: 40 ×
 * 1,000 rows covers a very long transcript in a handful of subrequests, well under the
 * Workers Free plan's limit of 50 subrequests per request. */
const REPLAY_PAGE_ROWS = 1000;
const REPLAY_PAGE_CAP = 40;

/**
 * Fold the durable log into `log`, from its cursor to the end; a page is up to
 * `REPLAY_PAGE_ROWS` rows. Past `REPLAY_PAGE_CAP` pages the loop stops and `log.truncated`
 * is set, so the caller renders what was folded plus a notice instead of the loop running
 * until it outruns the subrequest limit and throws.
 */
async function replayInto(env: Bindings, id: string, log: Transcript): Promise<Transcript> {
  for (let page = 0; page < REPLAY_PAGE_CAP; page++) {
    const response = await cf(
      env,
      `/sessions/${id}/events?after=${log.seq}&limit=${REPLAY_PAGE_ROWS}`,
    );
    if (!response.ok) throw new Error(`Event replay failed with ${response.status}`);
    const rows = await response.json<{ seq: number; event: SessionEvent }[]>();
    const last = rows.at(-1);
    if (!last) return log;
    for (const row of rows) log.apply(row.event);
    log.seq = last.seq;
  }
  log.truncated = true;
  return log;
}

/** A settled job: the folded log, plus the artifacts its checkpoint published. */
const settled = async (client: OpenAI, id: string, log: Transcript): Promise<JobState> =>
  log.state(await collect(client.beta.agents.sessions.artifacts.list(id)));

/** Frames of the live SSE stream: `id:` is the log sequence number, `data:` the event. */
async function* frames(
  reader: ReadableStreamDefaultReader<string>,
): AsyncGenerator<{ seq: number; event: SessionEvent }> {
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      let seq = 0;
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) seq = Number(line.slice(3));
        else if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      // Keepalive comments carry no data.
      if (data) yield { seq, event: JSON.parse(data) as SessionEvent };
    }
  }
}

/**
 * The job page while the turn runs: server-rendered and streamed, no client script. The
 * live stream is opened before the log is read, so no commit can fall between them; the
 * replay rebuilds the committed transcript, and live frames at or below its cursor are
 * skipped. Text deltas stream into an open block; every other change is one fragment
 * appended below it. A reload does the same again from the log: nothing is lost.
 */
async function streamJob(c: Context<{ Bindings: Bindings }>, id: string, session: Session) {
  const client = agentClient(c.env);
  const live = await client.beta.agents.sessions.events.stream(id).asResponse();
  if (!live.body) throw new Error("Event stream has no body");
  const log = await replayInto(c.env, id, new Transcript(session));
  if (!log.running) {
    // Settled between the retrieve and the replay: the plain page is exact.
    await live.body.cancel();
    return c.html(<Job id={id} state={await settled(client, id, log)} />);
  }
  const reader = live.body.pipeThrough(new TextDecoderStream()).getReader();
  c.header("content-type", "text/html; charset=UTF-8");
  return stream(
    c,
    async (out) => {
      // The browser went away: release the API's listener; the turn itself continues.
      out.onAbort(() => reader.cancel());
      const headState = log.state();
      const [head, tail] = await livePage(id, headState);
      await out.write(head);
      /** The text block currently open, if any. */
      const block: { open: { id: string; owner: Subagent | null } | null } = { open: null };
      // Item ids already rendered — in the head, or as a streamed text block — so a later
      // `item.done` for the same id (arriving live) is not rendered again.
      const rendered = new Set<string>(
        headState.entries.flatMap((entry) =>
          entry.kind === "item" && entry.item.id ? [entry.item.id] : [],
        ),
      );
      const close = async () => {
        if (block.open) await out.write(closeText(block.open.owner));
        block.open = null;
      };
      for await (const { seq, event } of frames(reader)) {
        if (seq <= log.seq) continue;
        log.seq = seq;
        const change = log.apply(event);
        if (!change) continue;
        if (change.kind === "text") {
          if (block.open?.id !== change.id) {
            await close();
            await out.write(openText(change.label, change.cls, change.owner));
            block.open = { id: change.id, owner: change.owner };
            rendered.add(change.id);
          }
          await out.write(escape(change.text));
          continue;
        }
        await close();
        if (change.kind === "settled") break;
        if (change.kind === "item" && change.item.id && rendered.has(change.item.id)) continue;
        // The fold kept this entry, so a reload renders the same view from the log.
        await out.write(await render(<EntryView entry={change} />));
      }
      await close();
      await reader.cancel();
      if (out.aborted) return;
      const sessions = client.beta.agents.sessions;
      const artifacts = log.running ? [] : await collect(sessions.artifacts.list(id));
      await out.write(
        (await render(<LiveEnd id={id} session={log.session} artifacts={artifacts} />)) + tail,
      );
    },
    async (error, out) => {
      console.error(error);
      await out.write(await render(<p class="error">{error.message}</p>));
    },
  );
}

/** An artifact's name below /workspace/outputs; that is where the instructions send them. */
const relative = (path: string) =>
  path.startsWith(OUTPUTS) ? path.slice(OUTPUTS.length) : path.replace(/^\/+/, "");

/** A download filename: the last segment, without the characters that end the quoting. */
const filename = (path: string) =>
  relative(path)
    .split("/")
    .at(-1)
    ?.replace(/["\\\r\n]/g, "") || "artifact";

/**
 * A zip entry name unique among those already used in this archive. Two artifacts can
 * `relative()` to the same name (one under /workspace/outputs, one outside it but sharing
 * the same tail); a repeat gets a numbered suffix instead of overwriting the first file.
 */
const uniqueEntryName = (used: ReadonlySet<string>, name: string): string => {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", async (c) => c.html(<Home presets={await presetNames(c.env)} />));

// Create the session with the prompt as its initial input; the turn keeps running
// after this request returns, and the job page follows it from the event log.
app.post("/jobs", async (c) => {
  const form = await c.req.formData();
  const prompt = field(form.get("prompt"));
  const model = field(form.get("model"));
  // With multi_agent enabled the runtime receives cf_delegate/cf_wait/cf_close for the
  // preset's `delegates` (src/agents.ts) and may start children on those presets.
  const subagents = form.get("subagents") === "on";
  if (!prompt || !model) return c.redirect("/");
  const session = await agentClient(c.env).beta.agents.sessions.create(
    {
      agent: {
        model,
        instructions: INSTRUCTIONS,
        multi_agent: subagents ? { enabled: true, max_concurrent_subagents: 2 } : null,
      },
      // `openai_hosted` is the SDK's wire name; here it selects a Cloudflare sandbox.
      environment: { type: "openai_hosted" },
      input: prompt,
    },
    { headers: { "Idempotency-Key": crypto.randomUUID() } },
  );
  return c.redirect(`/jobs/${session.id}`);
});

// A running job streams; a settled one (idle, failed, or requires_action, which this demo
// cannot answer because it declares no function tools) is one complete page. Both are the
// same fold over the same log, so the two pages render the same transcript.
app.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const client = agentClient(c.env);
  const session = await client.beta.agents.sessions.retrieve(id);
  if (running(session)) return streamJob(c, id, session);
  const log = await replayInto(c.env, id, new Transcript(session));
  return c.html(<Job id={id} state={await settled(client, id, log)} />);
});

// Bundle every artifact the completed turn published under /workspace/outputs, as long as
// the whole set fits in this Worker's memory; past that the job page links each file.
app.get("/jobs/:id/zip", async (c) => {
  const id = c.req.param("id");
  const sessions = agentClient(c.env).beta.agents.sessions;
  const artifacts = await collect(sessions.artifacts.list(id));
  if (artifacts.length === 0) return c.text("No artifacts for this session", 404);
  if (!zipFits(artifacts))
    return c.text("Too large to zip here; download the files one at a time", 413);
  const files: Record<string, Uint8Array> = {};
  const names = new Set<string>();
  for (const artifact of artifacts) {
    const response = await sessions.artifacts.content(artifact.id, { session_id: id });
    const name = uniqueEntryName(names, relative(artifact.path));
    names.add(name);
    files[name] = new Uint8Array(await response.arrayBuffer());
  }
  return c.body(zipSync(files), 200, {
    "content-type": "application/zip",
    // Same sanitizer as the per-file route below: the id is a route param too.
    "content-disposition": `attachment; filename="${filename(id)}.zip"`,
  });
});

// One artifact, passed straight through: the bytes stream from the API to the browser and
// no part of the file is ever held in the Worker, whatever its size.
app.get("/jobs/:id/files/:artifact", async (c) => {
  const id = c.req.param("id");
  const sessions = agentClient(c.env).beta.agents.sessions;
  const artifact = await sessions.artifacts.retrieve(c.req.param("artifact"), { session_id: id });
  const response = await sessions.artifacts.content(artifact.id, { session_id: id });
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${filename(artifact.path)}"`,
  });
  const length = response.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(response.body, { headers });
});

app.onError((error, c) => {
  console.error(error);
  const status =
    error instanceof OpenAI.APIError && typeof error.status === "number" ? error.status : 500;
  return c.html(<ErrorPage message={error.message} />, status as 500);
});

export default app;
// Wrangler binds the library's Durable Objects and the `Models` gateway by these names.
export {
  Agents,
  Models,
  SessionDO,
  TenantCatalogDO,
  HarnessDO,
  SandboxDO,
  ContainerProxy,
} from "./agents.js";
