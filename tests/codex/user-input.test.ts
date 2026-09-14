import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import { runPromise } from "../../packages/agent-api/src/index.js";
import { CodexJob } from "../../packages/supervisor/src/codex.js";

/**
 * Codex 0.154.0 answers the model's `request_user_input` call itself outside Plan
 * mode ("request_user_input is unavailable in Default mode"), so the app-server
 * request cannot be triggered through the real binary with this configuration.
 * A stand-in app-server exercises the projection path deterministically.
 */
const fakeAppServer = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const thread = { threadId: "thr_fake", turnId: "turn_fake" };
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 100) {
    writeFileSync("answers.json", JSON.stringify(message));
    out({ method: "item/completed", params: { ...thread, item: { type: "agentMessage", id: "msg_1", text: "Proceeding without input.", phase: "final_answer" } } });
    out({ method: "turn/completed", params: { ...thread, turn: { id: "turn_fake", status: "completed" } } });
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "thread/start") return out({ id: message.id, result: { thread: { id: "thr_fake" } } });
  if (message.method === "turn/start") {
    out({ id: message.id, result: { turn: { id: "turn_fake" } } });
    out({ method: "turn/started", params: { threadId: "thr_fake", turn: { id: "turn_fake" } } });
    out({ id: 100, method: "item/tool/requestUserInput", params: { ...thread, itemId: "item_q", isBlocking: true, questions: [{ id: "scope", header: "Scope", question: "Which file should be edited?", options: [{ label: "a.ts", description: "The first file" }] }] } });
    return;
  }
  out({ id: message.id, result: {} });
});
`;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const callback of cleanup.reverse()) await callback();
  cleanup.length = 0;
});

it("declines request_user_input questions as commentary and lets the turn continue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-codex-user-input-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "fake-app-server.mjs"), fakeAppServer);
  const binary = join(directory, "fake-app-server.sh");
  await writeFile(
    binary,
    `#!/bin/sh\nexec "${process.execPath}" "${join(directory, "fake-app-server.mjs")}"\n`,
  );
  await chmod(binary, 0o755);
  const diagnostics: string[] = [];
  const job = new CodexJob(
    {
      sessionId: "sess_input",
      turnId: "turn_input",
      generation: 1,
      harness: "codex",
      model: "gpt-5.4",
      agent: { model: "test" },
      input: [{ role: "user", content: [{ type: "input_text", text: "Edit a file." }] }],
      checkpoint: null,
      deadline: Date.now() + 60_000,
      sandbox: false,
    },
    {
      binary,
      directory,
      modelBaseUrl: "http://127.0.0.1:9/v1",
      sandboxUrl: "ws://unused",
      diagnostics: (line) => diagnostics.push(line),
    },
  );
  cleanup.push(() => runPromise(job.stop()));
  await runPromise(job.start());
  for (
    let attempt = 0;
    attempt < 100 && (await runPromise(job.poll(0))).status === "running";
    attempt++
  )
    await delay(50);
  const batch = await runPromise(job.poll(0));
  expect(batch.status, diagnostics.join("\n")).toBe("completed");
  const commentary = batch.events.find(
    ({ event }) => event.type === "text" && event.phase === "commentary",
  )?.event;
  if (commentary?.type !== "text") throw new Error("Missing commentary event");
  expect(commentary.text).toContain("Which file should be edited?");
  expect(commentary.text).toContain("Options: a.ts");
  expect(
    batch.events.some(({ event }) => event.type === "text" && event.phase === "final_answer"),
  ).toBe(true);
  const answered = JSON.parse(await readFile(join(directory, "answers.json"), "utf8")) as {
    result: { answers: Record<string, { answers: string[] }> };
  };
  expect(answered.result).toEqual({ answers: { scope: { answers: [] } } });
  expect(diagnostics.some((line) => line.includes("Rejected unsupported"))).toBe(false);
});
