import React from "react";
import { useCurrentFrame } from "remotion";

import { CodePanel, Footer, mono, Shell, Title } from "../ui";

const LINES = [
  "export const { Agents, Models, SessionDO, HarnessDO, SandboxDO, /* … */ } = defineAgentWorker({",
  "  agents: {",
  '    codex:   { harness: "codex",       model: "codex",   delegates: ["claude"] },',
  '    claude:  { harness: "claude-code", model: "primary", tiers: { haiku: "workers" } },',
  '    workers: { harness: "codex",       model: "workers" },',
  "  },",
  "  models: (env) => ({",
  '    codex:   () => nativeModel({ protocol: "responses", baseURL: "https://api.openai.com/v1",',
  '                                 apiKey: env.OPENAI_API_KEY, model: "gpt-6-astra" }),',
  '    primary: () => aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-6-astra")),',
  '    workers: () => aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/zai-org/glm-5.3-flash")),',
  "  }),",
  '  authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),',
  "});",
];

export const Compose: React.FC<{ title?: string }> = ({ title = "Three things you own." }) => {
  const f = useCurrentFrame();
  return (
    <Shell chapter="04 / THE COMPOSITION">
      <Title f={f}>{title}</Title>
      <CodePanel
        f={f}
        lines={LINES}
        from={40}
        stagger={8}
        fontSize={24}
        lineHeight={1.58}
        top={296}
        height={650}
        header="src/agents.ts"
        headerRight="defineAgentWorker"
        notes={[
          { line: 2, text: "presets · what clients name", at: 150 },
          { line: 7, text: "the private gateway · names → connections", at: 166 },
          { line: 13, text: "who is calling", at: 182 },
        ]}
      />
      <Footer>
        <span>Presets clients can name. A gateway that holds the keys. A tenant per caller.</span>
        <span style={{ fontFamily: mono, fontSize: 22 }}>
          nativeModel · aiSDKModel · openAICompatibleModel
        </span>
      </Footer>
    </Shell>
  );
};
