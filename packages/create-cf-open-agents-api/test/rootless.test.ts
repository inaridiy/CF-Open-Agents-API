import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { expect, it } from "vitest";

import { run, type Runner } from "../src/exec.js";
import {
  detectRootlessDocker,
  type InitOptions,
  ROOTLESS_FILES,
  rootlessScript,
  runInit,
} from "../src/index.js";
import {
  cleanup,
  cliPath,
  copyFixture,
  emptyDirectory,
  type Manifest,
  offline,
  packageRoot,
  readJson,
  silent,
  snapshot,
} from "./helpers.js";

const ROOTLESS_INFO = '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n';
const ROOTFUL_INFO = '["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]\n';
const DOCKER_INFO = "docker info --format {{json .SecurityOptions}}";
const bridge = join(packageRoot, "templates", "rootless", "netns-bridge.mjs");

/** A Docker engine answering `docker info` with the given security options. */
const engine =
  (info: string, calls: string[] = []): Runner =>
  (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "docker") return { ok: true, stdout: info, stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
const base = (dir: string, extra: Partial<InitOptions> = {}): InitOptions => ({
  dir,
  yes: true,
  force: false,
  dryRun: false,
  env: offline,
  reporter: silent(),
  token: () => "t".repeat(40),
  ...extra,
});

it("detects a rootless engine from docker info on Linux only", () => {
  const calls: string[] = [];
  expect(detectRootlessDocker(engine(ROOTLESS_INFO, calls), "linux")).toBe(true);
  expect(calls).toEqual([DOCKER_INFO]);
  expect(detectRootlessDocker(engine(ROOTFUL_INFO), "linux")).toBe(false);
  expect(detectRootlessDocker(engine(ROOTLESS_INFO), "darwin")).toBe(false);
  const down: Runner = () => ({ ok: false, stdout: "", stderr: "Cannot connect" });
  expect(detectRootlessDocker(down, "linux")).toBe(false);
});

it("a docker info that never answers is a failed detection, not a hang", () => {
  const options: { timeoutMs?: number }[] = [];
  const stalled: Runner = (_command, _args, runOptions) => {
    options.push({ timeoutMs: runOptions?.timeoutMs });
    return { ok: false, stdout: "", stderr: "docker info timed out after 5000 ms", timedOut: true };
  };
  expect(detectRootlessDocker(stalled, "linux")).toBe(false);
  expect(options).toEqual([{ timeoutMs: 5000 }]);
  // The real runner turns the timeout into that result.
  const started = Date.now();
  const result = run(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 300 });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(result).toMatchObject({ ok: false, timedOut: true });
  expect(result.stderr).toMatch(/timed out after 300 ms/);
});

it("offers the dev:rootless patch when Docker runs rootless and the default accepts it", async () => {
  const dir = copyFixture("vite-project");
  try {
    const calls: string[] = [];
    const { plan, answers } = await runInit(base(dir, { runner: engine(ROOTLESS_INFO, calls) }));
    expect(calls).toEqual([DOCKER_INFO]);
    expect(answers.rootless).toBe(true);
    expect(plan.created).toContain("scripts/dev-rootless.sh");
    expect(plan.created).toContain("scripts/netns-bridge.mjs");
    expect(Object.keys(ROOTLESS_FILES)).toEqual([
      "scripts/dev-rootless.sh",
      "scripts/netns-bridge.mjs",
    ]);
    // The package manager's exec prefix reaches the script through WRANGLER.
    expect(readJson<Manifest>(dir, "package.json").scripts["dev:rootless"]).toBe(
      'WRANGLER="npx wrangler" sh scripts/dev-rootless.sh',
    );
    expect(rootlessScript("pnpm")).toBe('WRANGLER="pnpm exec wrangler" sh scripts/dev-rootless.sh');
    expect(rootlessScript("bun")).toBe('WRANGLER="bunx wrangler" sh scripts/dev-rootless.sh');
    if (process.platform !== "win32") {
      // A syntax check of the written script; nsenter itself needs rootless Docker.
      const check = () =>
        execFileSync("sh", ["-n", join(dir, "scripts", "dev-rootless.sh")], { stdio: "pipe" });
      expect(check).not.toThrow();
    }
    const before = snapshot(dir);
    const again = await runInit(base(dir, { runner: engine(ROOTLESS_INFO) }));
    expect(again.plan.created).toEqual([]);
    expect(again.plan.updated).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  } finally {
    cleanup(dir);
  }
});

it("adds nothing on a rootful engine, and asks nothing when a flag decided", async () => {
  const dir = copyFixture("vite-project");
  try {
    const rootful = await runInit(base(dir, { runner: engine(ROOTFUL_INFO) }));
    expect(rootful.answers.rootless).toBe(false);
    expect(rootful.plan.created).not.toContain("scripts/dev-rootless.sh");
    expect(readJson<Manifest>(dir, "package.json").scripts["dev:rootless"]).toBeUndefined();
    const calls: string[] = [];
    const decided = await runInit(
      base(dir, { runner: engine(ROOTLESS_INFO, calls), rootless: false }),
    );
    expect(calls).toEqual([]);
    expect(decided.answers.rootless).toBe(false);
  } finally {
    cleanup(dir);
  }
});

it("--rootless forces the patch and --no-rootless skips the check", () => {
  const dir = copyFixture("vite-project");
  try {
    const plan = (...flags: string[]) =>
      execFileSync("node", [cliPath, "init", "--yes", "--dry-run", ...flags, dir], {
        env: { ...process.env, ...offline },
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(plan("--rootless")).toContain("scripts/dev-rootless.sh");
    expect(plan("--no-rootless")).not.toContain("dev-rootless");
    expect(plan("--no-code-loader")).not.toContain("CODE_LOADER");
  } finally {
    cleanup(dir);
  }
});

/** Starts one bridge process and resolves with the address it announced. */
function startBridge(args: string[]): Promise<{ child: ChildProcess; address: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (\S+)/.exec(output);
      if (match?.[1]) resolve({ child, address: match[1] });
    });
    child.stderr?.on("data", (chunk: Buffer) => reject(new Error(chunk.toString())));
    child.on("exit", (code) => reject(new Error(`bridge exited with ${code}`)));
  });
}
const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

/** Sends a request through the relay; `halfClose` ends the write side before the reply. */
function roundTrip(port: number, request: string, halfClose: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ port, host: "127.0.0.1" });
    let reply = "";
    client.on("data", (chunk: Buffer) => {
      reply += chunk.toString();
      if (!halfClose && reply === request) client.destroy();
    });
    client.on("error", reject);
    client.on("close", () => resolve(reply));
    client.write(request, () => {
      if (halfClose) client.end();
    });
  });
}

it.skipIf(process.platform === "win32")(
  "netns-bridge relays bytes both ways over the Unix socket, half-closed clients included",
  async () => {
    const dir = emptyDirectory();
    const children: ChildProcess[] = [];
    // An echo server standing in for wrangler; it ends its side once the client did.
    const echo = net.createServer((socket) => socket.pipe(socket));
    try {
      await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
      const echoPort = (echo.address() as net.AddressInfo).port;
      const sock = join(dir, "dev.sock");
      const inner = await startBridge(["unix-to-tcp", sock, String(echoPort)]);
      children.push(inner.child);
      expect(inner.address).toBe(sock);
      const outer = await startBridge(["tcp-to-unix", "0", sock]);
      children.push(outer.child);
      const port = Number(outer.address.split(":").at(-1));
      expect(port).toBeGreaterThan(0);
      // A client that half-closes after the request must still receive the echoed reply.
      expect(await roundTrip(port, "GET / HTTP/1.0\r\n\r\n", true)).toBe("GET / HTTP/1.0\r\n\r\n");
      expect(await roundTrip(port, "hello", false)).toBe("hello");
      await stop(inner.child);
      expect(existsSync(sock)).toBe(false);
    } finally {
      for (const child of children) await stop(child);
      echo.close();
      cleanup(dir);
    }
  },
);
