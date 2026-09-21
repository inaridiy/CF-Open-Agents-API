import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

import { clamp, CodePanel, Footer, mono, Shell, v } from "../ui";

const LINES = [
  "const client = new OpenAI({",
  '  baseURL: "https://agents.example.workers.dev/v1",',
  "  apiKey: process.env.AGENT_API_TOKEN,",
  "});",
  "const session = await client.beta.agents.sessions.create({",
  '  agent: { model: "codex" },',
  '  environment: { type: "openai_hosted" },',
  "});",
  "for await (const event of client.beta.agents.sessions.stream(session.id, {",
  '  input: "Write a short report to /workspace/outputs/report.md",',
  "})) {",
  '  if (event.type === "agent.session.turn.output_text.delta") process.stdout.write(event.delta);',
  "}",
];

// Title-demote-to-label (Shotcraft): 12f reveal, 20f hold, 20f continuous scale + position,
// then the code panel takes over. Settles at scale 0.61 to keep the film's large type.
export const SDK: React.FC<{ title?: string }> = ({ title = "Keep the official SDK." }) => {
  const f = useCurrentFrame();
  const dem = interpolate(f, [32, 52], [0, 1], {
    ...clamp,
    easing: Easing.inOut((t) => Easing.cubic(t)),
  });
  return (
    <Shell chapter="01 / KEEP THE SDK">
      <div
        style={{
          position: "absolute",
          left: interpolate(dem, [0, 1], [960, 120]),
          top: interpolate(dem, [0, 1], [425, 218]),
          transform: `translate(${-50 * (1 - dem)}%,-50%) scale(${interpolate(dem, [0, 1], [1, 0.61])})`,
          transformOrigin: "left center",
          fontSize: 128,
          fontWeight: 620,
          letterSpacing: -5,
          whiteSpace: "nowrap",
          opacity: v(f, 0, 12),
        }}
      >
        {title}
      </div>
      <CodePanel
        f={f}
        lines={LINES}
        from={62}
        stagger={9}
        top={296}
        height={630}
        header="app.ts"
        headerRight="THE OFFICIAL openai PACKAGE · UNCHANGED"
        notes={[
          { line: 2, text: "your Worker", at: 190 },
          { line: 6, text: "a preset your deployment defines", at: 202 },
          { line: 7, text: "a sandbox on your account", at: 214 },
        ]}
      />
      <Footer>
        <span>Sessions, turns, items, streaming, files, skills, MCP, subagents.</span>
        <span style={{ fontFamily: mono, fontSize: 22 }}>Service Binding or HTTPS</span>
      </Footer>
    </Shell>
  );
};
