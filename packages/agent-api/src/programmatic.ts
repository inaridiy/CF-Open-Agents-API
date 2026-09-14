import { RpcTarget, type WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { programmaticInputSchema } from "./programmatic-contract.js";
import { ApiError, type JsonValue } from "./protocol.js";

interface ProgrammaticOptions {
  input: z.infer<typeof programmaticInputSchema>;
  tools: readonly string[];
  call(name: string, args: JsonValue, signal: AbortSignal): Promise<JsonValue>;
  signal?: AbortSignal;
  /** Remaining execution budget, capped at two minutes. */
  timeoutMs?: number;
}
declare class ProgramWorker extends WorkerEntrypoint {
  run(bridge: ToolBridge, names: readonly string[], args: string): Promise<string>;
}

/** The only authority sent to generated code. Fields are private at the RPC boundary. */
class ToolBridge extends RpcTarget {
  #calls = 0;
  #active = 0;
  #bytes = 0;
  #uncertain = false;
  #options: ProgrammaticOptions;
  #signal: AbortSignal;
  constructor(options: ProgrammaticOptions, signal: AbortSignal) {
    super();
    this.#options = options;
    this.#signal = signal;
  }
  assertSettled(): void {
    if (this.#active) throw new Error("Await every tool call before returning from code");
    if (this.#uncertain) throw new Error("A tool call ended without a confirmed result");
  }
  get uncertain(): boolean {
    return this.#uncertain || this.#active > 0;
  }
  async call(name: string, serialized: string): Promise<string> {
    this.#signal.throwIfAborted();
    if (!this.#options.tools.includes(name)) throw new Error("Tool is not allowed");
    if (++this.#calls > 64 || this.#active >= 8) throw new Error("Tool call limit exceeded");
    if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > 128_000)
      throw new Error("Tool arguments exceed 128 KB");
    const args = z.json().parse(JSON.parse(serialized));
    this.#active++;
    try {
      const value = JSON.stringify(await this.#options.call(name, args, this.#signal));
      this.#signal.throwIfAborted();
      this.#bytes += new TextEncoder().encode(value).byteLength;
      if (this.#bytes > 1_048_576) throw new Error("Tool results exceed 1 MiB");
      return value;
    } catch (error) {
      this.#uncertain = true;
      throw error;
    } finally {
      this.#active--;
    }
  }
}

const wrapper = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import execute from './code.js';
export default class extends WorkerEntrypoint {
  async run(bridge, names, args) {
    try {
    const tools = Object.freeze(Object.fromEntries(names.map(name => [name, async input => {
      const encoded = JSON.stringify(input ?? {});
      if (new TextEncoder().encode(encoded).byteLength > 128000) throw new Error('Tool arguments exceed 128 KB');
      return JSON.parse(await bridge.call(name, encoded));
    }])));
    const result = JSON.stringify(await execute(tools, JSON.parse(args)) ?? null);
    if (new TextEncoder().encode(result).byteLength > 256000) throw new Error('Code result exceeds 256 KB');
    return result;
    } finally { bridge[Symbol.dispose](); }
  }
}`;

/** Fresh Worker per invocation, denied egress and narrowly scoped RPC capabilities. */
export async function runProgrammatic(
  loader: WorkerLoader,
  options: ProgrammaticOptions,
): Promise<JsonValue> {
  const input = programmaticInputSchema.parse(options.input);
  if ((options.timeoutMs ?? 120_000) <= 0)
    throw new ApiError(422, "programmatic_execution_failed", "Execution deadline expired");
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 256_000)
    throw new ApiError(413, "programmatic_input_too_large", "Code and arguments exceed 256 KB");
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bridge = new ToolBridge(options, signal);
  try {
    const worker = loader.load({
      compatibilityDate: "2026-09-12",
      mainModule: "main.js",
      modules: {
        "main.js": { js: wrapper },
        "code.js": { js: `export default async function(tools, args) {\n${input.code}\n}` },
      },
      globalOutbound: null,
      limits: { cpuMs: 1000, subRequests: 100 },
    });
    // WorkerLoader stubs have no dispose API in @cloudflare/workers-types 5.20260911.1:
    // an isolate abandoned by timeout stays resident until the platform collects it. Its
    // CPU budget is 1000 ms and it has no bindings, so only the settled promise must be
    // observed here to keep the rejection from surfacing as unhandled.
    const pending = worker
      .getEntrypoint<ProgramWorker>()
      .run(bridge, options.tools, JSON.stringify(input.arguments ?? null));
    pending.catch(() => {});
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Code execution was cancelled or timed out"));
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(
          () => controller.abort(),
          Math.max(1, Math.min(options.timeoutMs ?? 120_000, 120_000)),
        );
      }),
    ]);
    bridge.assertSettled();
    if (new TextEncoder().encode(result).byteLength > 256_000)
      throw new Error("Code result exceeds 256 KB");
    return z.json().parse(JSON.parse(result));
  } catch (error) {
    throw new ApiError(
      422,
      bridge.uncertain ? "programmatic_execution_uncertain" : "programmatic_execution_failed",
      error instanceof Error ? error.message : "Code execution failed",
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
