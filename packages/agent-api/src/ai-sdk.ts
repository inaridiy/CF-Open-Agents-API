import { DurableObject } from "cloudflare:workers";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  modelMessageSchema,
  tool,
} from "ai";
import { z } from "zod";
import { ApiError, identifier } from "./protocol.js";
import type {
  Checkpoint,
  Execution,
  RuntimeBatch,
  RuntimeCommand,
  RuntimeDriver,
} from "./runtime.js";
import { batchSchema } from "./runtime.js";
import { SqlStore } from "./storage.js";

interface State {
  execution: Execution;
  messages: ModelMessage[];
  batch: RuntimeBatch;
  phase: "queued" | "calling" | "settled";
  pending: { callId: string; name: string }[];
  operations: string[];
  steps: number;
}
export interface AIHarnessBindings {
  AI_HARNESS: DurableObjectNamespace<AIHarnessObject>;
  CHECKPOINTS: R2Bucket;
}

/** A durable sequence of AI SDK model steps; function execution remains external. */
export class AIHarnessObject<
  Env extends { CHECKPOINTS: R2Bucket } = AIHarnessBindings,
> extends DurableObject<Env> {
  private active?: AbortController;
  private readonly db = new SqlStore(this.ctx.storage);
  protected limits() {
    return { maxSteps: 32, maxOutputTokens: 8_192 };
  }
  protected model(_id: string): LanguageModel {
    throw new Error("Configure a model factory with createAIHarness");
  }
  async startExecution(execution: Execution): Promise<void> {
    const previous = this.db.get<State>("state", "execution");
    if (previous?.execution.turnId === execution.turnId) return;
    if (
      previous &&
      (previous.execution.generation >= execution.generation ||
        !["completed", "cancelled", "failed"].includes(previous.batch.status))
    )
      throw new ApiError(409, "stale_generation", "Execution was superseded");
    let messages: ModelMessage[] = [];
    if (execution.checkpoint) {
      const object = await this.env.CHECKPOINTS.get(execution.checkpoint.native);
      if (!object) throw new ApiError(409, "checkpoint_missing", "AI SDK checkpoint is missing");
      messages = await z.array(modelMessageSchema).parseAsync(await object.json());
    }
    messages.push(
      ...execution.input.map((message) => ({
        role: "user" as const,
        content: message.content.map((part) => part.text).join("\n"),
      })),
    );
    await this.ctx.storage.setAlarm(Date.now() + 1);
    this.db.put("state", "execution", {
      execution,
      messages,
      batch: { status: "running", events: [], cursor: 0 },
      phase: "queued",
      pending: [],
      operations: [],
      steps: 0,
    });
  }
  override async alarm(): Promise<void> {
    const state = this.db.get<State>("state", "execution");
    if (state?.phase !== "queued" || this.active) return;
    if (state.steps >= this.limits().maxSteps) {
      state.batch.status = "failed";
      state.batch.error = "model_step_limit";
      state.phase = "settled";
      this.db.put("state", "execution", state);
      return;
    }
    this.active = new AbortController();
    state.phase = "calling";
    this.db.put("state", "execution", state);
    try {
      const result = await generateText({
        model: this.model(state.execution.model),
        system: state.execution.agent.instructions ?? undefined,
        messages: state.messages,
        tools: Object.fromEntries(
          (state.execution.agent.tools ?? []).map((definition) => [
            definition.name,
            tool({
              description: definition.description,
              inputSchema: jsonSchema(definition.parameters),
            }),
          ]),
        ),
        maxRetries: 0,
        maxOutputTokens: this.limits().maxOutputTokens,
        abortSignal: AbortSignal.any([
          this.active.signal,
          AbortSignal.timeout(Math.max(1, state.execution.deadline - Date.now())),
        ]),
      });
      const current = this.db.get<State>("state", "execution");
      if (
        !current ||
        current.execution.turnId !== state.execution.turnId ||
        current.batch.status === "cancelled"
      )
        return;
      if (!["stop", "tool-calls"].includes(result.finishReason))
        throw new Error("Model output is incomplete");
      state.steps++;
      state.messages.push(...result.response.messages);
      if (result.text)
        state.batch.events.push({
          seq: ++state.batch.cursor,
          event: { type: "text", id: identifier("msg"), text: result.text, phase: "final_answer" },
        });
      for (const call of result.toolCalls) {
        state.pending.push({ callId: call.toolCallId, name: call.toolName });
        state.batch.events.push({
          seq: ++state.batch.cursor,
          event: {
            type: "function_call",
            id: identifier("call"),
            callId: call.toolCallId,
            name: call.toolName,
            arguments: z.json().parse(call.input),
          },
        });
      }
      state.batch.status = state.pending.length ? "waiting" : "completed";
      state.phase = "settled";
      this.db.put("state", "execution", state);
    } catch {
      const current = this.db.get<State>("state", "execution");
      if (
        current?.execution.turnId === state.execution.turnId &&
        current.batch.status !== "cancelled"
      ) {
        current.batch.status = "failed";
        current.batch.error = "model_request_failed";
        current.phase = "settled";
        this.db.put("state", "execution", current);
      }
    } finally {
      this.active = undefined;
    }
  }
  async pollExecution(turnId: string, after: number): Promise<Response> {
    const state = this.db.get<State>("state", "execution");
    if (!state || state.execution.turnId !== turnId)
      return Response.json({ status: "missing", events: [], cursor: 0 });
    if (state.phase === "calling" && !this.active) {
      state.batch.status = "failed";
      state.batch.error = "outcome_unknown";
      state.phase = "settled";
      this.db.put("state", "execution", state);
    }
    return Response.json({
      ...state.batch,
      events: state.batch.events.filter((event) => event.seq > after),
    });
  }
  async controlExecution(
    turnId: string,
    operationId: string,
    command: RuntimeCommand,
  ): Promise<void> {
    const state = this.db.get<State>("state", "execution");
    if (!state || state.execution.turnId !== turnId)
      throw new ApiError(409, "stale_generation", "Execution was superseded");
    if (state.operations.includes(operationId)) return;
    if (command.type === "steer")
      throw new ApiError(409, "active_turn_not_steerable", "AI SDK turns cannot be steered");
    if (command.type === "cancel") {
      this.active?.abort();
      state.batch.status = "cancelled";
      state.phase = "settled";
    } else {
      const call = state.pending.find((call) => call.callId === command.callId);
      if (!call) throw new ApiError(409, "invalid_tool_result", "No matching tool call");
      state.messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.callId,
            toolName: call.name,
            output: { type: command.success ? "text" : "error-text", value: command.output },
          },
        ],
      });
      state.pending = state.pending.filter((value) => value !== call);
      if (!state.pending.length) {
        await this.ctx.storage.setAlarm(Date.now() + 1);
        state.phase = "queued";
        state.batch.status = "running";
      }
    }
    state.operations.push(operationId);
    this.db.put("state", "execution", state);
  }
  async checkpointExecution(turnId: string): Promise<Checkpoint> {
    const state = this.db.get<State>("state", "execution");
    if (!state || state.execution.turnId !== turnId || state.batch.status !== "completed")
      throw new ApiError(409, "invalid_checkpoint", "Turn must be complete");
    const native = `sessions/${state.execution.sessionId}/${state.execution.generation}/ai-sdk.json`;
    await this.env.CHECKPOINTS.put(native, JSON.stringify(state.messages));
    return { version: 1, driver: "ai-sdk", revision: "1", native };
  }
  async stopExecution(turnId: string): Promise<void> {
    const state = this.db.get<State>("state", "execution");
    if (state?.execution.turnId === turnId) {
      this.active?.abort();
      state.phase = "settled";
      state.batch.status = "cancelled";
      this.db.put("state", "execution", state);
    }
  }
}

export function createAIHarness<Env extends { CHECKPOINTS: R2Bucket }>(
  resolveModel: (env: Env, model: string) => LanguageModel,
  limits: { maxSteps?: number; maxOutputTokens?: number } = {},
): new (
  ctx: DurableObjectState,
  env: Env,
) => AIHarnessObject<Env> {
  const resolved = z
    .object({
      maxSteps: z.number().int().min(1).max(128).default(32),
      maxOutputTokens: z.number().int().min(1).max(128_000).default(8_192),
    })
    .parse(limits);
  return class extends AIHarnessObject<Env> {
    protected override limits() {
      return resolved;
    }
    protected override model(id: string): LanguageModel {
      return resolveModel(this.env, id);
    }
  };
}
export function aiSDKDriver(env: AIHarnessBindings): RuntimeDriver {
  const stub = (execution: Execution) => env.AI_HARNESS.getByName(execution.sessionId);
  return {
    name: "ai-sdk",
    revision: "1",
    capabilities: { steer: false, functions: true, sandbox: false },
    start: async (execution) => {
      await stub(execution).startExecution(execution);
    },
    poll: async (execution, after) =>
      batchSchema.parse(
        await (await stub(execution).pollExecution(execution.turnId, after)).json(),
      ),
    control: async (execution, id, command) => {
      await stub(execution).controlExecution(execution.turnId, id, command);
    },
    checkpoint: async (execution) => stub(execution).checkpointExecution(execution.turnId),
    stop: async (execution) => {
      await stub(execution).stopExecution(execution.turnId);
    },
  };
}
