import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const address = "http://127.0.0.1:8799";
const occupied = await fetch(address, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
if (occupied) throw new Error("Port 8799 is occupied; stop the existing test Worker first");
const directory = await mkdtemp(join(tmpdir(), "cf-open-agents-api-containers-"));
const logPath = join(directory, "wrangler.log");
const log = createWriteStream(logPath);
const worker = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    "tests/containers/wrangler.jsonc",
    "--port",
    "8799",
    "--persist-to",
    join(directory, "state"),
  ],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
);
worker.stdout.pipe(log, { end: false });
worker.stderr.pipe(log, { end: false });
const exit = once(worker, "exit");
try {
  console.log(`Building local Containers; log: ${logPath}`);
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited: ${worker.exitCode}`);
    const response = await fetch(`${address}/cf/v1/capabilities`, {
      headers: { authorization: "Bearer local-container-test" },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (response?.ok) {
      ready = true;
      break;
    }
    await delay(1_000);
  }
  if (!ready) throw new Error("Wrangler did not become ready within five minutes");
  const smoke = spawn(process.execPath, ["scripts/container-smoke.mjs"], { stdio: "inherit" });
  const [code] = /** @type {[number]} */ (await once(smoke, "exit"));
  if (code !== 0) throw new Error(`Container smoke exited: ${code}`);
} catch (error) {
  console.error((await readFile(logPath, "utf8")).split("\n").slice(-80).join("\n"));
  throw error;
} finally {
  if (worker.pid && worker.exitCode === null) {
    const pid = worker.pid;
    process.kill(-pid, "SIGTERM");
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }, 5_000);
    await exit;
    clearTimeout(timer);
  }
  log.end();
}
