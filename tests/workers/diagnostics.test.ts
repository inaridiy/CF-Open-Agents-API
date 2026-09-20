/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { expect, it } from "vitest";

import {
  diagnosticsHint,
  WORKER_UNREACHABLE_HINT,
} from "../../packages/agent-api/src/containers.js";

it("hints at an unreachable Worker when a runtime could not connect to an internal host", () => {
  expect(
    diagnosticsHint([
      "codex: starting turn",
      "native_turn_failed (connection_failed): stream disconnected before completion: error sending request for url (http://model.internal/v1/responses)",
    ]),
  ).toBe(WORKER_UNREACHABLE_HINT);
  expect(
    diagnosticsHint([
      "failed to connect to exec-server websocket `ws://sandbox.internal/`: IO error: Connection reset by peer (os error 104)",
    ]),
  ).toBe(WORKER_UNREACHABLE_HINT);
  expect(diagnosticsHint(["TypeError: fetch failed http://mcp.internal/search ECONNREFUSED"])).toBe(
    WORKER_UNREACHABLE_HINT,
  );
  expect(diagnosticsHint(["delegate.internal: connect ETIMEDOUT 10.0.0.1:80"])).toBe(
    WORKER_UNREACHABLE_HINT,
  );
});

it("adds no hint for other diagnostics", () => {
  expect(diagnosticsHint([])).toBeUndefined();
  // An internal host that answered is not a connectivity problem.
  expect(
    diagnosticsHint(["unexpected status 429 from http://model.internal/v1/responses"]),
  ).toBeUndefined();
  // A connection failure elsewhere is the sandbox's own egress, not the Worker.
  expect(
    diagnosticsHint([
      "error sending request for url (https://api.example.com/v1): Connection refused",
    ]),
  ).toBeUndefined();
  expect(diagnosticsHint(["claude-code turn failed (internal_error): {}"])).toBeUndefined();
});
