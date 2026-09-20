import { type AgentRPC, tenantFetch } from "cf-open-agents-api/cloudflare";
import { zipSync } from "fflate";
import { type Context, Hono } from "hono";
import { stream } from "hono/streaming";
import OpenAI from "openai";

import {
  closeText,
  ErrorPage,
  escape,
  Home,
  Job,
  type JobState,
  LiveEnd,
  LiveItem,
  livePage,
  LiveSubagent,
  LiveTurnError,
  openText,
  render,
} from "./ui.js";

interface Bindings {
  /** Self Service Binding to this Worker's `Agents` entrypoint (see wrangler.jsonc). */
  AGENTS: Fetcher & AgentRPC;
}

type Session = OpenAI.Beta.Agents.AgentSession;
type SessionEvent = OpenAI.Beta.Agents.AgentSessionEvent;
type Item = OpenAI.Beta.Agents.AgentSessionItem;
type Subagent = OpenAI.Beta.Agents.Subagent;
type Turn = OpenAI.Beta.Agents.Sessions.Turn;

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

/** The committed state of a settled session, from the SDK's list endpoints. */
async function loadJob(client: OpenAI, id: string, session: Session): Promise<JobState> {
  const sessions = client.beta.agents.sessions;
  const [items, children] = await Promise.all([
    collect(sessions.items.list(id, { order: "asc", limit: 100 })),
    collect(sessions.subagents.list(id, { order: "asc" })),
  ]);
  // Delegated children report through the parent session but keep their own items.
  const subagents = await Promise.all(
    children.map(async (subagent) => ({
      subagent,
      items: await collect(
        sessions.subagents.items.list(subagent.id, { session_id: id, order: "asc", limit: 100 }),
      ),
    })),
  );
  const artifacts = running(session) ? [] : await collect(sessions.artifacts.list(id));
  return { session, items, subagents, artifacts, running: running(session) };
}

async function collect<T>(page: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of page) out.push(item);
  return out;
}

// --- The event log ----------------------------------------------------------------------

/** What one event changed, for the live page to append; the fold keeps the state itself. */
type Change =
  | { kind: "text"; id: string; owner: Subagent | null; label: string; cls: string; text: string }
  | { kind: "item"; item: Item; owner: Subagent | null }
  | { kind: "subagent"; subagent: Subagent }
  | { kind: "turn_failed"; turn: Turn }
  | { kind: "settled" };

/**
 * A fold over the session's event log. The same reducer rebuilds the committed transcript
 * from `GET /cf/v1/sessions/:id/events?after=<seq>` and applies the live stream after it,
 * so a page loaded mid-turn shows exactly what the log holds and then continues from it.
 */
class Transcript {
  session: Session;
  readonly items = new Map<string, Item>();
  readonly subagents = new Map<string, { subagent: Subagent; items: Map<string, Item> }>();
  /** Turn id → subagent id: an item's turn tells whose transcript it belongs to. */
  private readonly turns = new Map<string, string | null>();
  /** The last sequence number applied; live frames at or below it are duplicates. */
  seq = 0;

  constructor(session: Session) {
    this.session = session;
  }

  get running(): boolean {
    return running(this.session);
  }

  state(): JobState {
    return {
      session: this.session,
      items: [...this.items.values()],
      subagents: [...this.subagents.values()].map(({ subagent, items }) => ({
        subagent,
        items: [...items.values()],
      })),
      artifacts: [],
      running: this.running,
    };
  }

  /** The transcript an item of `turnId` belongs to: a delegated child's, or the root's. */
  private owner(turnId: string | null): Owner {
    const subagentId = turnId ? this.turns.get(turnId) : null;
    const entry = subagentId ? this.subagents.get(subagentId) : undefined;
    return entry
      ? { subagent: entry.subagent, items: entry.items }
      : { subagent: null, items: this.items };
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
        return event.turn.error ? { kind: "turn_failed", turn: event.turn } : null;
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
    const entry = this.subagents.get(subagent.id);
    if (entry) entry.subagent = subagent;
    else this.subagents.set(subagent.id, { subagent, items: new Map() });
    return announce ? { kind: "subagent", subagent } : null;
  }

  private applyItem(owner: Owner, item: Item, done: boolean): Change | null {
    if (item.id && (done || !owner.items.has(item.id))) owner.items.set(item.id, item);
    return done ? { kind: "item", item, owner: owner.subagent } : null;
  }

  private applyText(owner: Owner, itemId: string, delta: string): Change | null {
    const item = owner.items.get(itemId);
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
    const item = owner.items.get(itemId);
    if (item?.type !== "reasoning") return null;
    // Summary parts are shown joined by newlines, as the reasoning item view does.
    const newPart = item.summary.length > 0 && item.summary.length <= index;
    while (item.summary.length <= index) item.summary.push({ type: "summary_text", text: "" });
    const part = item.summary[index];
    if (part) part.text += delta;
    const text = (newPart ? "\n" : "") + delta;
    return {
      kind: "text",
      id: itemId,
      owner: owner.subagent,
      label: "thinking",
      cls: "reasoning",
      text,
    };
  }
}

/** Where an event's item is stored and, for a delegated child, whose it is. */
interface Owner {
  subagent: Subagent | null;
  items: Map<string, Item>;
}

/** One page of the durable log after `seq`; the route returns at most 100 rows. */
async function replay(env: Bindings, id: string, after: number) {
  const response = await cf(env, `/sessions/${id}/events?after=${after}`);
  if (!response.ok) throw new Error(`Event replay failed with ${response.status}`);
  return response.json<{ seq: number; event: SessionEvent }[]>();
}

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
  const log = new Transcript(session);
  for (let after = 0; ;) {
    const rows = await replay(c.env, id, after);
    const last = rows.at(-1);
    if (!last) break;
    for (const row of rows) log.apply(row.event);
    after = log.seq = last.seq;
  }
  if (!log.running) {
    // Settled between the retrieve and the replay: the plain page is exact.
    await live.body.cancel();
    return c.html(<Job id={id} state={await loadJob(client, id, log.session)} />);
  }
  const reader = live.body.pipeThrough(new TextDecoderStream()).getReader();
  c.header("content-type", "text/html; charset=UTF-8");
  return stream(
    c,
    async (out) => {
      // The browser went away: release the API's listener; the turn itself continues.
      out.onAbort(() => reader.cancel());
      const [head, tail] = await livePage(id, log.state());
      await out.write(head);
      /** The text block currently open, if any. */
      const block: { open: { id: string; owner: Subagent | null } | null } = { open: null };
      /** Items whose text streamed live; their `item.done` would repeat it. */
      const streamed = new Set<string>();
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
            streamed.add(change.id);
          }
          await out.write(escape(change.text));
          continue;
        }
        await close();
        if (change.kind === "settled") break;
        if (change.kind === "item") {
          if (change.item.id && streamed.has(change.item.id)) continue;
          await out.write(await render(<LiveItem item={change.item} owner={change.owner} />));
        } else if (change.kind === "subagent")
          await out.write(await render(<LiveSubagent subagent={change.subagent} />));
        else await out.write(await render(<LiveTurnError turn={change.turn} />));
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
// cannot answer because it declares no function tools) is one complete page.
app.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const client = agentClient(c.env);
  const session = await client.beta.agents.sessions.retrieve(id);
  if (running(session)) return streamJob(c, id, session);
  return c.html(<Job id={id} state={await loadJob(client, id, session)} />);
});

// Bundle every artifact the completed turn published under /workspace/outputs.
app.get("/jobs/:id/zip", async (c) => {
  const id = c.req.param("id");
  const sessions = agentClient(c.env).beta.agents.sessions;
  const files: Record<string, Uint8Array> = {};
  for await (const artifact of sessions.artifacts.list(id)) {
    const response = await sessions.artifacts.content(artifact.id, { session_id: id });
    const name = artifact.path.startsWith(OUTPUTS)
      ? artifact.path.slice(OUTPUTS.length)
      : artifact.path.replace(/^\/+/, "");
    files[name] = new Uint8Array(await response.arrayBuffer());
  }
  if (Object.keys(files).length === 0) return c.text("No artifacts for this session", 404);
  return c.body(zipSync(files), 200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${id}.zip"`,
  });
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
