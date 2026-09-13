import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Config } from "@opencode-ai/sdk/v2/types";
import type { Execution } from "cf-open-agents-api";
import { type NativeOptions, ToolJob } from "./job.js";

export class OpenCodeJob extends ToolJob {
  readonly home: string;
  private child?: ChildProcess;
  constructor(execution: Execution, options: NativeOptions) {
    super(execution, options);
    this.home = join(options.directory, "opencode");
  }
  protected async open(bundle?: unknown): Promise<void> {
    const previous = await this.prepare(bundle);
    // Native OpenCode installs plugin dependencies into writable config directories.
    // Our plugin is already bundled: a read-only config keeps startup offline.
    const configDirectory = join(this.home, "config", "opencode");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, ".gitignore"), "*\n");
    await chmod(configDirectory, 0o555);
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No OpenCode port available");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const tools = {
      "*": false,
      bash: this.execution.sandbox,
      read: this.execution.sandbox,
      write: this.execution.sandbox,
      edit: this.execution.sandbox,
      "workspace_function_*": true,
    };
    const config: Config = {
      model: `gateway/${this.execution.model}`,
      small_model: `gateway/${this.execution.model}`,
      enabled_providers: ["gateway"],
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      plugin: [new URL("./opencode-tools.js", import.meta.url).href],
      permission: {
        "*": "deny",
        bash: this.execution.sandbox ? "allow" : "deny",
        read: this.execution.sandbox ? "allow" : "deny",
        write: this.execution.sandbox ? "allow" : "deny",
        edit: this.execution.sandbox ? "allow" : "deny",
        "workspace_function_*": "allow",
      },
      tools,
      agent: { title: { disable: true }, summary: { disable: true }, build: { steps: 32 } },
      mcp: {
        workspace: {
          type: "remote",
          url: `${this.options.supervisorUrl}/jobs/${this.execution.turnId}/mcp`,
          oauth: false,
          timeout: Math.max(1000, this.execution.deadline - Date.now()),
        },
      },
      provider: {
        gateway: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: this.options.modelBaseUrl,
            apiKey: "private-worker-gateway",
            timeout: 120_000,
          },
          models: {
            [this.execution.model]: {
              name: this.execution.model,
              limit: { context: 128_000, output: 8192 },
              tool_call: true,
            },
          },
        },
      },
    };
    const password = crypto.randomUUID();
    const child = spawn(
      this.options.opencodeBinary,
      ["serve", "--hostname=127.0.0.1", `--port=${address.port}`],
      {
        cwd: this.options.directory,
        env: {
          PATH: process.env.PATH,
          HOME: this.home,
          XDG_CONFIG_HOME: join(this.home, "config"),
          XDG_DATA_HOME: join(this.home, "data"),
          XDG_CACHE_HOME: join(this.home, "cache"),
          XDG_STATE_HOME: join(this.home, "state"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          CF_WORKSPACE_ENDPOINT: `${this.options.supervisorUrl}/jobs/${this.execution.turnId}/workspace`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr?.on("data", (data) => this.options.diagnostics(String(data)));
    child.once("exit", () => {
      if (!this.closing && !["completed", "cancelled", "failed"].includes(this.status))
        this.failStart(new Error("OpenCode exited"));
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("OpenCode startup timed out")), 30_000);
      let output = "";
      child.stdout?.on("data", (data) => {
        output = (output + String(data)).slice(-4096);
        if (output.includes("opencode server listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("OpenCode exited during startup"));
      });
    });
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      throwOnError: true,
    });
    const sessionId =
      previous ?? (await client.session.create({ title: this.execution.sessionId })).data?.id;
    if (!sessionId) throw new Error("OpenCode did not create a session");
    this.sessionId = sessionId;
    if (previous) await client.session.get({ sessionID: previous });
    this.run(async () => {
      const updates = new AbortController();
      const events = await client.event.subscribe({}, { signal: updates.signal });
      let streamError: unknown;
      const consume = (async () => {
        for await (const event of events.stream) {
          if (
            event.type === "message.part.delta" &&
            event.properties.sessionID === this.sessionId &&
            event.properties.field === "text"
          )
            this.emit({ type: "delta", id: event.properties.partID, text: event.properties.delta });
        }
      })().catch((error) => {
        if (!updates.signal.aborted) {
          streamError = error;
          this.abort.abort();
        }
      });
      try {
        const result = await client.session.prompt(
          {
            sessionID: this.sessionId,
            model: { providerID: "gateway", modelID: this.execution.model },
            parts: this.execution.input.flatMap((message) =>
              message.content.map((part) => ({ type: "text" as const, text: part.text })),
            ),
            system: this.execution.agent.instructions ?? undefined,
            tools,
          },
          { signal: this.abort.signal },
        );
        if (streamError) throw streamError;
        if (
          !result.data ||
          result.data.info.error ||
          !["stop", "end_turn"].includes(result.data.info.finish ?? "")
        )
          throw new Error("OpenCode turn failed");
        for (const part of result.data.parts)
          if (part.type === "text")
            this.emit({ type: "text", id: part.id, text: part.text, phase: "final_answer" });
      } finally {
        updates.abort();
        await consume;
      }
    });
  }
  protected async closeRuntime(): Promise<void> {
    await chmod(join(this.home, "config", "opencode"), 0o755).catch(() => {});
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child?.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
}
