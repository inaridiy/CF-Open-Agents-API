import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";

import { THEME as T } from "../timeline";
import { Chip, Eyebrow, Footer, mono, rise, Shell, v } from "../ui";

export const Outro: React.FC<{ title?: string; cta?: string }> = ({
  title = "Build on it.",
  cta = "Try it. File an issue. Contribute.",
}) => {
  const f = useCurrentFrame();
  return (
    <Shell>
      <Eyebrow>A small invitation to the open-source community</Eyebrow>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 250,
          fontSize: 123,
          fontWeight: 620,
          letterSpacing: -6,
          ...rise(f, 0, 22, 30),
        }}
      >
        {title}
      </div>
      <div
        style={{
          position: "absolute",
          left: 124,
          top: 420,
          display: "flex",
          gap: 14,
          opacity: v(f, 18, 40),
        }}
      >
        <Chip blue>Open source</Chip>
        <Chip>Apache-2.0</Chip>
        <Chip>Alpha</Chip>
        <Chip monoText>npm: cf-open-agents-api</Chip>
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 520,
          width: 1680,
          height: 100,
          background: "#fff",
          border: `1px solid ${T.line}`,
          borderRadius: 18,
          display: "flex",
          alignItems: "center",
          padding: "0 36px",
          gap: 24,
          fontFamily: mono,
          fontSize: 32,
          ...rise(f, 26, 24, 12),
        }}
      >
        <span style={{ color: T.muted }}>$</span>
        <span>pnpm dlx create-cf-open-agents-api@alpha init</span>
        <span style={{ marginLeft: "auto", fontSize: 21, color: T.muted }}>
          a Worker, the API and a demo app
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 650,
          width: 1680,
          height: 132,
          background: "#fff",
          border: `1px solid ${T.line}`,
          borderRadius: 18,
          display: "flex",
          alignItems: "center",
          padding: "0 36px",
          gap: 29,
          ...rise(f, 36, 24, 12),
        }}
      >
        <Img src={staticFile("brands/github.svg")} style={{ width: 54, height: 54 }} />
        <span style={{ fontFamily: mono, fontSize: 38, letterSpacing: -1 }}>
          github.com/inaridiy/CF-Open-Agents-API
        </span>
        <span style={{ marginLeft: "auto", fontSize: 54, color: T.blue }}>↗</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 124,
          top: 830,
          fontSize: 36,
          color: T.blue,
          opacity: v(f, 50, 74),
        }}
      >
        {cta}
      </div>
      <Footer>
        <span style={{ fontSize: 23 }}>
          Independent implementation. Not affiliated with OpenAI, Anthropic, OpenCode or Cloudflare.
        </span>
      </Footer>
    </Shell>
  );
};
