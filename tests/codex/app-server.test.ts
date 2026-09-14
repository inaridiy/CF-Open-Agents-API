import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import { AppServer } from "../../packages/supervisor/src/json-rpc.js";

/**
 * A stand-in app-server: answers `initialize` after printing one unparseable line,
 * exits on the `exit-now` notification, and echoes any other request.
 */
const fakeServer = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "exit-now") process.exit(0);
  if (message.id === undefined) return;
  if (message.method === "initialize") process.stdout.write("this is not json\\n");
  process.stdout.write(JSON.stringify({ id: message.id, result: { method: message.method } }) + "\\n");
});
`;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const callback of cleanup.reverse()) await callback();
  cleanup.length = 0;
});
async function fakeBinary() {
  const directory = await mkdtemp(join(tmpdir(), "cf-fake-app-server-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "fake-app-server.mjs"), fakeServer);
  const binary = join(directory, "fake-app-server.sh");
  await writeFile(
    binary,
    `#!/bin/sh\nexec "${process.execPath}" "${join(directory, "fake-app-server.mjs")}"\n`,
  );
  await chmod(binary, 0o755);
  return { directory, binary };
}

it("drops a malformed app-server line without failing the request in flight", async () => {
  const { directory, binary } = await fakeBinary();
  const diagnostics: string[] = [];
  const exited = Promise.withResolvers<void>();
  const server = new AppServer({
    binary,
    directory,
    home: directory,
    onMessage: () => {},
    onExit: () => exited.resolve(),
    onDiagnostic: (line) => diagnostics.push(line),
  });
  cleanup.push(() => server.stop());
  await expect(server.request("initialize", {})).resolves.toEqual({ method: "initialize" });
  expect(diagnostics.some((line) => line.includes("dropped malformed message"))).toBe(true);
  await expect(server.request("thread/start", {})).resolves.toEqual({ method: "thread/start" });
});

it("writes to an exited app-server are dropped instead of crashing the process", async () => {
  const { directory, binary } = await fakeBinary();
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  cleanup.push(async () => {
    process.off("uncaughtException", onUncaught);
  });
  const exited = Promise.withResolvers<void>();
  const diagnostics: string[] = [];
  const server = new AppServer({
    binary,
    directory,
    home: directory,
    onMessage: () => {},
    onExit: () => exited.resolve(),
    onDiagnostic: (line) => diagnostics.push(line),
  });
  cleanup.push(() => server.stop());
  await server.request("initialize", {});
  server.notify("exit-now");
  // Racing writes while the child is going away exercise the broken-pipe path.
  for (let i = 0; i < 50; i++) {
    server.notify("late", { i });
    server.respond(i, {});
    server.reject(i);
    await delay(2);
  }
  await exited.promise;
  server.notify("after-exit");
  server.respond(1, {});
  await expect(server.request("initialize", {})).rejects.toThrow("App-server is closed");
  await delay(50);
  expect(uncaught).toEqual([]);
});

it("the exit of the app-server rejects requests that were still pending", async () => {
  const { directory, binary } = await fakeBinary();
  const server = new AppServer({
    binary,
    directory,
    home: directory,
    onMessage: () => {},
    onExit: () => {},
    onDiagnostic: () => {},
  });
  cleanup.push(() => server.stop());
  await server.request("initialize", {});
  const pending = server.request("never-answered", {});
  server.notify("exit-now");
  await expect(pending).rejects.toThrow("App-server exited");
  await once(server as unknown as NodeJS.EventEmitter, "never").catch(() => {});
});
