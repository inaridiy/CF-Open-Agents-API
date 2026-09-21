import React from "react";
import { useCurrentFrame } from "remotion";

import { THEME as T } from "../timeline";
import { Footer, mono, rise, Shell, Title } from "../ui";

const TILES: [string, string][] = [
  ["Shell and files", "in the session's sandbox"],
  ["Hosted web search", "or a search of your own"],
  ["MCP servers", "service-origin servers use Vault credentials via the Worker"],
  ["Skills", "immutable, integrity-checked R2 bundles"],
  ["Programmatic tools", "model-written code in an isolated Dynamic Worker"],
  ["Delegation", "Codex hands work to Claude Code, or back"],
  ["Subagents", "native subagents with their own items and turns"],
  ["Forks", "branch a session from its last checkpoint"],
];

export const Tools: React.FC<{ title?: string }> = ({ title = "More than a shell." }) => {
  const f = useCurrentFrame();
  return (
    <Shell chapter="08 / ENVIRONMENTS AND TOOLS">
      <Title f={f}>{title}</Title>
      {TILES.map(([name, sub], i) => (
        <div
          key={name}
          style={{
            position: "absolute",
            left: 120 + (i % 4) * 426,
            top: 318 + Math.floor(i / 4) * 236,
            width: 402,
            height: 212,
            border: `1px solid ${T.line}`,
            borderRadius: 18,
            background: "#fff",
            padding: "28px 30px",
            boxShadow: "0 8px 25px #1a1a1a06",
            ...rise(f, 12 + i * 6, 24, 22),
          }}
        >
          <div style={{ fontFamily: mono, fontSize: 18, color: T.blue, marginBottom: 14 }}>
            0{i + 1}
          </div>
          <div style={{ fontSize: 31, fontWeight: 600, letterSpacing: -0.6, marginBottom: 10 }}>
            {name}
          </div>
          <div style={{ fontSize: 22, color: T.muted, lineHeight: 1.4 }}>{sub}</div>
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 815,
          fontSize: 33,
          color: T.ink,
          ...rise(f, 90, 26, 10),
        }}
      >
        Function calls become durable <span style={{ fontFamily: mono }}>required_actions</span>.
        Your client submits the results.
      </div>
      <Footer>
        <span>Every tool runs inside your account, under your policy.</span>
      </Footer>
    </Shell>
  );
};
