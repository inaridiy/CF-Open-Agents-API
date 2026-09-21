import { html, raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import type OpenAI from "openai";

type Session = OpenAI.Beta.Agents.AgentSession;
type Item = OpenAI.Beta.Agents.AgentSessionItem;
type Artifact = OpenAI.Beta.Agents.Sessions.SessionArtifact;
type Subagent = OpenAI.Beta.Agents.Subagent;
type Turn = OpenAI.Beta.Agents.Sessions.Turn;

/**
 * One renderable step of the transcript. The fold in src/index.tsx keeps these in the
 * order the event log produced them and hands the live page the very same values, so a
 * streamed fragment and the page a reload rebuilds are the same view.
 */
export type Entry =
  | { kind: "item"; item: Item; owner: Subagent | null }
  | { kind: "subagent"; subagent: Subagent }
  | { kind: "turn_failed"; turn: Turn };

export interface JobState {
  session: Session;
  entries: readonly Entry[];
  artifacts: Artifact[];
  /** True while the initial turn is still running; the job page then streams the rest. */
  running: boolean;
  /** True when replay stopped at the page cap before reaching the end of the log. */
  truncated: boolean;
}

const CSS = `
  :root { font-family: system-ui, sans-serif; line-height: 1.5; --line: #e1e1de; --muted: #6b6b67; --accent: #2563eb; }
  body { margin: 0; background: #f6f6f4; color: #1a1a1a; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font-size: 1.125rem; } h1 a { color: inherit; text-decoration: none; }
  h2 { margin: 0; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .meta { font-size: 0.875rem; color: var(--muted); }
  form { display: grid; gap: 12px; }
  textarea, select, button, input { font: inherit; accent-color: var(--accent); }
  textarea, select { border: 1px solid var(--line); border-radius: 8px; background: #fff; color: inherit; }
  textarea { width: 100%; box-sizing: border-box; padding: 12px 14px; resize: vertical; } select { padding: 6px 10px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button, a.button { display: inline-block; padding: 10px 18px; cursor: pointer; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
  form button { margin-left: auto; }
  .row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; font-size: 0.875rem; color: var(--muted); }
  .row label { display: inline-flex; align-items: center; gap: 8px; }
  .status { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 16px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: #fff; font-size: 0.875rem; }
  .status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #16a34a; }
  .status.running::before { background: var(--accent); animation: pulse 1.2s infinite; } .status.failed::before { background: #dc2626; }
  .status.requires_action::before { background: #b45309; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .item, .outputs { margin: 8px 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fff; --role: var(--muted); }
  .item .label, .from > .label { font-size: 0.75rem; font-weight: 600; color: var(--role); text-transform: uppercase; letter-spacing: 0.04em; }
  .item.user { --role: var(--accent); background: #edf2fd; }
  .item.final_answer { --role: #15803d; } .item.command { --role: #b45309; } .item.subagent { --role: #7e22ce; }
  .item.reasoning { border-style: dashed; background: none; color: var(--muted); }
  pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0 0; font-size: 0.875rem; }
  .command pre { max-height: 240px; overflow: auto; }
  pre.output { padding: 8px 10px; border-radius: 6px; background: #f6f6f4; }
  code { font-size: 0.875rem; }
  .error { color: #dc2626; }
  .from { margin: 8px 0; padding-left: 14px; border-left: 2px solid #e9d5ff; --role: #7e22ce; }
  .from .item { background: #f6f6f4; }
  .from > .label { display: block; margin-top: 8px; }
  ul.files { list-style: none; margin: 0 0 12px; padding: 0; }
  ul.files li { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 0.875rem; }
`;

/** Marks where the live page's streamed fragments go; `livePage` splits the layout there. */
const LIVE_MARK = "<!--live-->";

/**
 * How much this demo will buffer to build a zip. `zipSync` holds every input file AND the
 * finished archive in memory at once, so peak usage is roughly twice this total; a Worker
 * has 128 MB, so the limit is kept well under half of that. The API itself allows far more
 * per turn (200 MiB per file, 500 MiB per turn; see containers/checkpoint.ts). Past this
 * total, which one oversized file crosses on its own, the page offers a download per file.
 */
const ZIP_LIMIT = 32 * 1024 * 1024;

/** Decided from the artifact metadata alone: `size_bytes` is the published size. */
export const zipFits = (artifacts: readonly Artifact[]): boolean =>
  artifacts.reduce((total, artifact) => total + artifact.size_bytes, 0) <= ZIP_LIMIT;

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{raw(CSS)}</style>
    </head>
    <body>
      <main>
        <header>
          <h1>
            <a href="/">Agent Builder</a>
          </h1>
          <span class="meta">cf-open-agents-api demo</span>
        </header>
        {children}
      </main>
    </body>
  </html>
);

export const Home: FC<{ presets: readonly string[] }> = ({ presets }) => (
  <Layout title="Agent Builder">
    <p>Describe what you want built. An agent builds it in a sandbox and returns a zip.</p>
    <form method="post" action="/jobs">
      <textarea
        name="prompt"
        rows={6}
        required
        placeholder="Example: a tic-tac-toe game as a single HTML file"
      />
      <div class="row">
        <label>
          preset{" "}
          <select name="model">
            {presets.map((preset) => (
              <option value={preset}>{preset}</option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" name="subagents" /> subagents (cf_delegate to the other presets)
        </label>
        <button type="submit">Build</button>
      </div>
    </form>
  </Layout>
);

export const ErrorPage: FC<{ message: string }> = ({ message }) => (
  <Layout title="Error">
    <p class="error">{message}</p>
  </Layout>
);

const messageText = (item: Extract<Item, { type: "message" }>) =>
  item.content.map((part) => (part.type === "input_image" ? "[image]" : part.text)).join("");

const agentText = (content: readonly OpenAI.Beta.Agents.AgentContent[]) =>
  content.map((part) => (part.type === "output_text" ? part.text : "[encrypted]")).join("");

const clip = (text: string, max = 4000) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;

/**
 * A reasoning item is one text: its summary parts joined by this separator. The fold
 * writes the same separator ahead of the first delta of a new part, so a block streamed
 * live and the finished item read alike.
 */
export const SUMMARY_SEPARATOR = "\n";

const summaryText = (item: Extract<Item, { type: "reasoning" }>) =>
  item.summary.map((part) => part.text).join(SUMMARY_SEPARATOR);

const ItemView: FC<{ item: Item }> = ({ item }) => {
  switch (item.type) {
    case "message":
      return (
        <div class={`item ${item.role} ${item.phase ?? ""}`}>
          <div class="label">{item.role === "user" ? "you" : (item.phase ?? "assistant")}</div>
          <pre>{messageText(item)}</pre>
        </div>
      );
    case "reasoning":
      return (
        <div class="item reasoning">
          <div class="label">thinking</div>
          <pre>{summaryText(item)}</pre>
        </div>
      );
    case "command_execution":
      return (
        <div class="item command">
          <div class="label">
            shell · {item.status}
            {item.exit_code !== null ? ` · exit ${item.exit_code}` : ""}
          </div>
          <pre>$ {clip(item.command)}</pre>
          {item.output ? <pre class="output">{clip(item.output)}</pre> : null}
        </div>
      );
    case "create_subagent_call":
      return (
        <div class="item subagent">
          <div class="label">
            delegate → {item.model ?? "?"} ({item.agent_id}) · {item.status}
          </div>
          <pre>{agentText(item.content)}</pre>
        </div>
      );
    case "send_subagent_input_call":
      return (
        <div class="item subagent">
          <div class="label">
            send → {item.recipient_agent_id} · {item.status}
          </div>
          <pre>{agentText(item.content)}</pre>
        </div>
      );
    case "wait_for_subagents_call":
      return (
        <div class="item subagent">
          <div class="label">
            wait for {item.recipient_agent_ids.join(", ")} · {item.status}
          </div>
        </div>
      );
    case "close_subagent_call":
      return (
        <div class="item subagent">
          <div class="label">
            close {item.recipient_agent_id} · {item.status}
          </div>
        </div>
      );
    default:
      return (
        <div class="item">
          <div class="label">{item.type}</div>
        </div>
      );
  }
};

const ownerLabel = (owner: Subagent) => `subagent ${owner.name ?? owner.id}`;

/** An item of a delegated child, labelled with the subagent whose turn produced it. */
const From: FC<PropsWithChildren<{ owner: Subagent | null }>> = ({ owner, children }) =>
  owner ? (
    <div class="from">
      <span class="label">{ownerLabel(owner)}</span>
      {children}
    </div>
  ) : (
    <>{children}</>
  );

/** One entry of the transcript; the committed page and the live stream both render this. */
export const EntryView: FC<{ entry: Entry }> = ({ entry }) => {
  switch (entry.kind) {
    case "item":
      return (
        <From owner={entry.owner}>
          <ItemView item={entry.item} />
        </From>
      );
    case "subagent":
      return (
        <div class="item subagent">
          <div class="label">
            {ownerLabel(entry.subagent)} · {entry.subagent.status}
          </div>
          {entry.subagent.instructions && entry.subagent.status === "active" ? (
            <pre>{agentText(entry.subagent.instructions)}</pre>
          ) : null}
        </div>
      );
    default:
      return (
        <p class="error">
          turn {entry.turn.id} failed
          {entry.turn.error ? ` — ${entry.turn.error.message}` : ""}
        </p>
      );
  }
};

/**
 * The status pill. A failed turn returns the session to `idle` with `session.error` set,
 * so the error is shown next to the status. `requires_action` means the runtime called a
 * function tool; this demo declares none, so nothing will ever answer it.
 */
const Status: FC<{ session: Session; running: boolean }> = ({ session, running }) => (
  <p class={`status ${running ? "running" : session.status}`}>
    {running ? "building…" : session.status}
    {session.status === "requires_action"
      ? " — waiting for a tool result this demo never sends"
      : null}
    {session.error ? <span class="error"> — {session.error}</span> : null}
  </p>
);

/** The committed transcript: status, every entry in log order, and the download once done. */
const Progress: FC<{ id: string; state: JobState }> = ({ id, state }) => {
  const { session, entries, artifacts, running, truncated } = state;
  return (
    <section id="progress">
      <Status session={session} running={running} />
      {truncated ? (
        <p class="meta">Transcript truncated: too many events to replay in one request.</p>
      ) : null}
      {entries.map((entry) => (
        <EntryView entry={entry} />
      ))}
      {running ? null : <Outputs id={id} artifacts={artifacts} />}
    </section>
  );
};

const size = (bytes: number) => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The download control, and which one it is offering: one zip while the outputs fit in a
 * Worker's memory, otherwise a link per file that streams straight from the API.
 */
const Outputs: FC<{ id: string; artifacts: Artifact[] }> = ({ id, artifacts }) => {
  if (artifacts.length === 0) return <p>No files were written to /workspace/outputs.</p>;
  const zip = zipFits(artifacts);
  return (
    <div class="outputs">
      <h2>Outputs</h2>
      <ul class="files">
        {artifacts.map((artifact) => (
          <li>
            {zip ? (
              <code>{artifact.path}</code>
            ) : (
              <a href={`/jobs/${id}/files/${artifact.id}`}>
                <code>{artifact.path}</code>
              </a>
            )}
            <span class="meta">{size(artifact.size_bytes)}</span>
          </li>
        ))}
      </ul>
      {zip ? (
        <a class="button" href={`/jobs/${id}/zip`}>
          Download zip
        </a>
      ) : (
        <p class="meta">
          These outputs are over {ZIP_LIMIT / (1024 * 1024)} MB together, more than this Worker zips
          in memory: download them one at a time from the list above.
        </p>
      )}
    </div>
  );
};

const JobPage: FC<PropsWithChildren<{ id: string; state: JobState }>> = ({
  id,
  state,
  children,
}) => (
  <Layout title={`Job ${id}`}>
    <p class="meta">
      session <code>{id}</code> · preset <code>{state.session.agent.model}</code>
    </p>
    <Progress id={id} state={state} />
    {children}
  </Layout>
);

/** A settled job: one complete page. */
export const Job: FC<{ id: string; state: JobState }> = ({ id, state }) => (
  <JobPage id={id} state={state} />
);

/**
 * A node's markup. hono types a JSX node as its markup string but the value is a node;
 * `html` resolves it (every view here is synchronous) to an escaped String object.
 */
export const render = async (
  node: HtmlEscapedString | Promise<HtmlEscapedString>,
): Promise<string> => (await html`${node}`).valueOf();

/**
 * A running job as two halves of the same page: the head with the committed transcript,
 * written first, and the tail written after the live fragments once the turn settles.
 */
export async function livePage(id: string, state: JobState): Promise<[string, string]> {
  const page = await render(
    <JobPage id={id} state={state}>
      {raw(LIVE_MARK)}
    </JobPage>,
  );
  const at = page.indexOf(LIVE_MARK);
  return [page.slice(0, at), page.slice(at + LIVE_MARK.length)];
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text for a fragment written outside JSX, such as a streamed delta. */
export const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

/** A text block left open while its deltas stream in; `closeText` ends it. */
export const openText = (label: string, cls: string, owner: Subagent | null): string =>
  `${owner ? `<div class="from"><span class="label">${escape(ownerLabel(owner))}</span>` : ""}` +
  `<div class="item ${escape(cls)}"><div class="label">${escape(label)}</div><pre>`;

export const closeText = (owner: Subagent | null): string => `</pre></div>${owner ? "</div>" : ""}`;

/**
 * The end of a live page: the final status replaces the pill written at the top. The head
 * of the page was flushed long ago and nothing can edit that pill from here, so a `<style>`
 * rule hides it instead.
 */
export const LiveEnd: FC<{ id: string; session: Session; artifacts: Artifact[] }> = ({
  id,
  session,
  artifacts,
}) => (
  <>
    <style>{raw("#progress > .status { display: none; }")}</style>
    <Status session={session} running={session.status === "in_progress"} />
    {session.status === "in_progress" ? (
      <p class="error">The event stream ended before the turn settled; reload to reattach.</p>
    ) : (
      <Outputs id={id} artifacts={artifacts} />
    )}
  </>
);
