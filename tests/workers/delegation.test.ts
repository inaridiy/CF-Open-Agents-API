/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { expect, it } from "vitest";

import { childExecution } from "../../packages/agent-api/src/containers/delegation.js";
import type { Assignment } from "../../packages/agent-api/src/persistence/harness-kinds.js";

type Delegation = NonNullable<Assignment["delegation"]>;

const parent: Assignment = {
  sessionId: "sess_parent",
  generation: 4,
  turnId: "turn_parent",
  model: "gw-lead",
  harness: "codex",
  dispatched: true,
  sandbox: true,
};
const delegation = (delegates: Delegation["delegates"]): Delegation => ({
  delegates,
  maxConcurrentSubagents: 2,
  deadline: 1_000,
  agent: {
    model: "lead",
    instructions: "lead instructions",
    tools: [
      { type: "web_search", mode: "live" },
      { type: "function", name: "look_up", description: "", parameters: {} },
    ],
    multi_agent: { enabled: true },
  },
});
const spawn = { subagentId: "subagent_1", turnId: "turn_child", prompt: "go", capabilityRoots: [] };
const toolTypes = (execution: { agent: { tools?: readonly { type: string }[] | null } }) =>
  (execution.agent.tools ?? []).map((tool) => tool.type);

it("keeps the parent's hosted search only for a delegate that resolved it, whatever the harness", () => {
  const searcher = {
    alias: "searcher",
    harness: "claude-code",
    model: "gw-child",
    webSearch: true,
  };
  const plain = { alias: "plain", harness: "codex", model: "gw-child", webSearch: false };
  const config = delegation([searcher, plain]);
  // A non-Codex child whose preset and runtime provide hosted search keeps the tool,
  // where the harness name alone used to drop it.
  expect(toolTypes(childExecution(parent, config, searcher, spawn))).toEqual([
    "web_search",
    "function",
  ]);
  // A Codex child whose model connection does not provide search loses it, where the
  // harness name alone used to keep it.
  expect(toolTypes(childExecution(parent, config, plain, spawn))).toEqual(["function"]);
});

it("drops hosted search for a delegate recorded before the capability was resolved", () => {
  const delegate = { alias: "legacy", harness: "codex", model: "gw-child" };
  const execution = childExecution(parent, delegation([delegate]), delegate, spawn);
  expect(toolTypes(execution)).toEqual(["function"]);
  expect(execution.parent).toEqual({ turnId: "turn_parent", subagentId: "subagent_1" });
  expect(execution.agent.multi_agent).toEqual({ enabled: false });
});
