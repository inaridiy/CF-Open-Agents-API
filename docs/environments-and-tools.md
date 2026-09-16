# Configure environments, tools, subagents and forks

Use the `client` from the [Service Binding guide](service-binding.md#connect-the-official-client). The same calls work over [hosted HTTP](http-api.md). These examples assume the example deployment's presets and its `containerEnvironments` driver. See the [compatibility profile](compatibility.md) for the limits and the capability flags each harness reports.

## Images, web search and streamed progress

Hosted web search needs a preset whose model connection provides it (`webSearch: true`, like the example's `coding` preset) on Codex or Claude Code. OpenCode has no hosted search; expose search as a function tool there. Images work on every harness; the portable AI SDK adapter still needs a provider that accepts them.

```ts
const visual = await client.beta.agents.sessions.create({
  agent: {
    model: "coding",
    reasoning: { summary: "detailed" },
    tools: [{ type: "web_search", mode: "cached", allowed_domains: ["developer.mozilla.org"] }],
  },
  environment: { type: "none" },
});
for await (const event of client.beta.agents.sessions.stream(visual.id, {
  input: [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Explain this screenshot and check the relevant documentation.",
        },
        { type: "input_image", image_url: screenshotUrl },
      ],
    },
  ],
})) {
  if (event.type === "agent.session.turn.output_text.delta") console.log(event.delta);
  if (event.type === "agent.session.turn.reasoning_summary_text.delta") console.log(event.delta);
  if (event.type === "agent.output.command_execution_output.delta") console.log(event.delta);
  if (event.type === "agent.session.turn.completed") console.log(event.usage);
}
```

Set `screenshotUrl` to an HTTP(S) URL the runtime can fetch, or a base64 image data URL. Larger images should use URLs to stay within the [storage limits](compatibility.md#durability-and-limits); a turn may reference at most 256 distinct remote images. `cached` searches saved web content; `live` allows live retrieval and is the default when the tool is present without a mode. Omit the tool or use `disabled` to turn it off. `context_size`, `allowed_domains` and `location` are forwarded to Codex's provider search tool; Claude Code enforces `allowed_domains` on its hosted `WebSearch`. See the [official search contract](https://developers.openai.com/api/docs/guides/agents-api/tools/web-search).

SDK `toolHandlers` can return JSON objects, strings, `null`, or arrays of `{ type: "input_text", text }` and `{ type: "input_image", image_url }`. The SDK serializes objects to JSON text and preserves content arrays. Failed handlers send a generic error; their exception details are not exposed to the model. See [function tools](service-binding.md#function-tools) for a complete example. Inspect `required_actions` to identify outstanding calls. Cancelling a turn closes unfinished output as `incomplete` and retains already observed token usage.

Mark rarely used functions with `defer_loading: true`, or add `{ type: "tool_search" }`, and the runtime discovers them by description on demand instead of carrying every schema in each request.

## Steer a running turn

Input submitted while a turn is active is added to that turn on every harness:

```ts
await client.beta.agents.sessions.events.create(
  session.id,
  {
    events: [
      {
        type: "agent.session.input.message",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Also add a summary at the top." }],
          },
        ],
      },
    ],
  },
  { headers: { "Idempotency-Key": "task-123-steer-1" } },
);
```

The message appears as an input item of the current turn. If the runtime has already finished when the message arrives, the message is not lost: it runs as the next turn. Cancellation supersedes queued steers.

## Structured output

Ask for a JSON document with `text.format`; every harness enforces the schema natively:

```ts
const structured = await client.beta.agents.sessions.create({
  agent: {
    model: "coding",
    text: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            files: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "files"],
          additionalProperties: false,
        },
      },
    },
  },
  environment: { type: "openai_hosted" },
});
```

The final assistant message is the validated JSON text. Codex passes the schema on `turn/start`, Claude Code uses `outputFormat`, OpenCode uses its `StructuredOutput` tool. On Claude Code and OpenCode, a turn whose structured output never arrives fails with `internal_error`.

## Start with files, skills and an environment template

Upload larger or binary input through the Files API. The returned `file_id` belongs to the authenticated tenant; another tenant cannot use it to seed an environment. Publish reusable skills once through the Skills API and reference them by ID; a session pins the version it resolved, so later uploads or deletion never change a running session.

```ts
const source = await client.files.create({
  purpose: "user_data",
  file: new File(["name,value\nexample,42\n"], "input.csv", { type: "text/csv" }),
});
const skill = await client.skills.create({
  files: new File(
    ["---\nname: report-style\ndescription: House style for reports\n---\nWrite tersely.\n"],
    "SKILL.md",
  ),
});
const template = await client.beta.agents.environments.templates.create({
  name: "report-workspace",
  network: { access: "disabled" },
  env: { REPORT_LANGUAGE: "Japanese" },
  files: [{ type: "file_id", file_id: source.id, path: "/workspace/input.csv" }],
  skills: [{ type: "skill_reference", skill_id: skill.id }],
  setup_commands: [{ command: "mkdir -p /workspace/outputs", cwd: "/workspace" }],
});
const session = await client.beta.agents.sessions.create({
  agent: { model: "coding", reasoning: { effort: "high" } },
  environment: { type: "openai_hosted", environment_template_id: template.id },
});
```

Skills also accept a ZIP archive or several files, immutable numbered versions through `client.skills.versions.create`, a default version pointer, and a `skill_reference` with `version: "latest"` or a specific number. Codex discovers installed skills and plugins natively; Claude Code and OpenCode receive the discovered metadata in their instructions and read `SKILL.md` on demand.

Environment variables and setup command bodies are omitted from public resource responses. A session can narrow its template's network policy; it cannot broaden it. Package installation and commands needing network access require an appropriate policy. `openai_hosted` runs on your Cloudflare sandbox in this implementation. Setup commands run on a fresh sandbox; while the sandbox is reused between turns their effects persist, and after a restore they run again.

Session creation can return a failed environment if setup fails. Retrieve its state before submitting work:

```ts
if (session.environment.type !== "openai_hosted") throw new Error("Expected an environment");
const environment = await client.beta.agents.environments.retrieve(session.environment.id);
if (environment.status !== "connected") throw new Error(`Environment: ${environment.status}`);
```

Retrieval also emits `agent.session.environment.disconnected` or `connected` on the session when the sandbox went away or came back.

Upload changes and list files independently of a model turn:

```ts
await client.beta.agents.environments.files.create(environment.id, {
  type: "inline",
  path: "/workspace/notes.txt",
  data: btoa("Include a summary."),
});
for await (const file of client.beta.agents.environments.files.list(environment.id, {
  path: "/workspace",
  order: "asc",
  limit: 20,
}))
  console.log(file.path, file.size_bytes);
```

Use byte-safe base64 encoding for binary or non-Latin text; `btoa` above receives ASCII. Environment listings use `page`/`next` tokens, which the official SDK follows automatically. Files are live workspace content; they become immutable artifacts only after a completed turn. Explicit uploads are journaled and reapplied when a sandbox is restored.

## Retrieve an artifact after completion

Ask the agent to write deliverables under `/workspace/outputs`. After its root turn completes, retrieve the published bytes:

```ts
for await (const artifact of client.beta.agents.sessions.artifacts.list(session.id)) {
  const response = await client.beta.agents.sessions.artifacts.content(artifact.id, {
    session_id: session.id,
  });
  const bytes = await response.arrayBuffer();
  console.log(artifact.path, bytes.byteLength);
}
```

Artifacts survive destruction of the live container. Updating a live file does not change a previously published artifact. Deleting an artifact does not delete the live file or its original Files API object. Download needed artifacts before deleting the session; [physical retention](deployment.md#checkpoint-operations) is separate.

## Attach a credential to service-origin MCP

Vaults let you reuse an MCP credential without embedding it in each agent definition. Read `MCP_TOKEN` from your application's secret binding. This example sends it only when creating the credential; returned resources omit the token.

```ts
const vault = await client.beta.agents.vaults.create({ name: "application-tools" });
const credential = await client.beta.agents.vaults.credentials.create(vault.id, {
  name: "knowledge-service",
  auth: {
    type: "static_bearer",
    mcp_server_url: "https://tools.example.com/mcp",
    token: env.MCP_TOKEN,
  },
});
const withMcp = await client.beta.agents.sessions.create({
  agent: {
    model: "coding",
    tools: [
      {
        type: "mcp",
        server_label: "knowledge",
        connection_origin: "service",
        transport: { type: "http", server_url: "https://tools.example.com/mcp" },
        credential_id: credential.id,
        allowed_tools: ["lookup"],
        required: true,
      },
    ],
  },
  environment: { type: "openai_hosted" },
  vault_ids: [vault.id],
});
```

Replace the example URL and tool name with your MCP server's values. Matching uses the configured server URL and the attached vaults. If several credentials match, select `credential_id`. Redirects are rejected before credentials can reach a new URL. `request_metadata` is merged into service-origin JSON-RPC request metadata. The same configuration works for every harness: Codex connects natively, Claude Code and OpenCode connect through the supervisor's tool bridge.

Environment-origin HTTP and stdio MCP servers run inside the execution environment (Codex natively; a private bridge for the other harnesses). Vault injection applies to service-origin HTTP only. Environment-origin metadata and credential selection are rejected, because the sandbox filesystem would hold the secret. Keep model-provider keys in the private gateway; they are separate from MCP credentials and environment variables.

## Let the model orchestrate tools in code

`programmatic_tool_calling` gives the runtime a `cf_execute` tool that runs model-written JavaScript in a fresh isolated Worker. The code receives `tools`, an object of async functions for the session's client functions, MCP tools and, with a sandbox, the workspace tools. It has no network, filesystem or credentials, and only its returned JSON value reaches the model.

```ts
const batch = await client.beta.agents.sessions.create({
  agent: {
    model: "coding",
    tools: [
      { type: "programmatic_tool_calling" },
      {
        type: "function",
        name: "lookup",
        description: "Look up one record",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    ],
  },
  environment: { type: "openai_hosted" },
});
for await (const event of client.beta.agents.sessions.stream(batch.id, {
  input: "Look up records 1 through 20 in parallel and summarize them.",
  toolHandlers: { lookup: async ({ id }) => ({ id, value: await readRecord(id) }) },
})) {
  if (event.type === "agent.session.turn.output_text.delta") console.log(event.delta);
}
```

Each function the code calls still surfaces as a `function_call` item and a `required_actions` entry, so handlers run exactly as they do for direct calls. The deployment must bind `CODE_LOADER`; without it, `programmatic_tool_calling` is rejected with `unsupported_capability`. Code that returns while calls are still outstanding ends the turn as `programmatic_execution_uncertain`; see the [durability rules](compatibility.md#durability-and-limits).

## Run subagents

With `multi_agent.enabled`, every harness may start native subagents: Codex threads, Claude Code's `Task` tool, OpenCode's `task` tool. When the deployment also lists `delegates` for the session's preset, the runtime receives `cf_delegate`, `cf_wait` and `cf_close` tools that start children on the listed presets. A delegated child runs in its own harness container, shares the parent's workspace, and reports through the same session:

```ts
const parallel = await client.beta.agents.sessions.create({
  agent: { model: "coding", multi_agent: { enabled: true, max_concurrent_subagents: 3 } },
  environment: { type: "openai_hosted" },
});
let rootTurnId: string | undefined;
for await (const event of client.beta.agents.sessions.stream(parallel.id, {
  input: "Have a reviewer check this repository while you write the summary.",
})) {
  if (event.type === "agent.session.turn.created" && !event.turn.subagent_id)
    rootTurnId = event.turn.id;
  if (event.type === "agent.session.turn.output_text.delta" && event.turn_id === rootTurnId)
    console.log(event.delta);
  if (event.type === "agent.session.turn.failed" && !event.turn.subagent_id)
    throw new Error("Root turn failed");
}
for await (const child of client.beta.agents.sessions.subagents.list(parallel.id)) {
  console.log(child.id, child.status);
  for await (const item of client.beta.agents.sessions.subagents.items.list(child.id, {
    session_id: parallel.id,
  }))
    console.log(item.type);
}
```

Child turns share the session event stream. Use the turn's `subagent_id` to associate lifecycle events, and `turn_id` to associate text. A child's terminal event is not the root turn's completion; the root completes after its children. A child's function calls appear in `required_actions` with the child's `turn_id`, and SDK `toolHandlers` answer them like any other call. The runtime decides whether to delegate; enabling subagents allows it but does not force a decomposition. Children are single-turn and cannot delegate further.

The example deployment lets `coding`, `claude` and `opencode` delegate to each other; see [extending](extending.md#presets-harnesses-and-the-model-gateway) for the configuration.

## Fork a session

Forking creates a new idle session from a committed one. It is the recovery path after an indeterminate outcome, and the way to move a conversation to another runtime or model. Overrides use the session-create `agent` shape:

```ts
const forked = await fetch(`https://agents.internal/cf/v1/sessions/${session.id}/fork`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${env.API_TOKEN}`,
    "content-type": "application/json",
    "Idempotency-Key": "review-with-claude-1",
  },
  body: JSON.stringify({ agent: { model: "claude" }, metadata: { forked_from: session.id } }),
});
const review = await forked.json();
for await (const event of client.beta.agents.sessions.stream(review.id, {
  input: "Review the report you find in /workspace/outputs.",
})) {
  if (event.type === "agent.session.turn.output_text.delta") console.log(event.delta);
}
```

Send the request through the same Service Binding or HTTP route as the SDK client; over RPC, call `forkSession(tenant, id, parameters, key)`. A fork on the same harness revision with the same tool surface continues the native conversation. A fork onto another harness inherits the last committed workspace and reads a transcript of the source's public items as leading input on its first turn. The source session is unchanged, and the fork starts with an empty item list of its own.
