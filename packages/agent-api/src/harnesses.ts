/** Native versions identify resumable state formats as well as executable pins. */
export const HARNESSES = {
  codex: { revision: "0.154.0", protocol: "/v1/responses", steer: true },
  "claude-code": { revision: "0.3.268", protocol: "/v1/messages", steer: true },
  opencode: { revision: "1.18.30", protocol: "/v1/chat/completions", steer: true },
} as const;
export type HarnessName = keyof typeof HARNESSES;
