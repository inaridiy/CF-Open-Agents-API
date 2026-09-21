import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";

import { THEME as T } from "../timeline";
import { Footer, mono, rise, Shell, Title, v } from "../ui";

const BRANDS = [
  { name: "Codex", src: "codex.svg", sub: "OpenAI", size: 84, harness: "codex" },
  {
    name: "Claude Code",
    src: "claude-code.png",
    sub: "Anthropic",
    size: 96,
    harness: "claude-code",
  },
  { name: "OpenCode", src: "opencode.svg", sub: "Open source", size: 90, harness: "opencode" },
];

export const Runtimes: React.FC<{ title?: string }> = ({
  title = "The runtimes keep their own loops.",
}) => {
  const f = useCurrentFrame();
  return (
    <Shell chapter="03 / NATIVE RUNTIMES">
      <Title f={f}>{title}</Title>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 318,
          width: 1680,
          height: 470,
          border: "2px solid #cfdbf5",
          borderRadius: 28,
          background: T.pale,
          opacity: v(f, 8, 30),
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 24,
            left: 36,
            display: "flex",
            alignItems: "center",
            gap: 20,
            fontSize: 27,
            fontWeight: 560,
          }}
        >
          <Img
            src={staticFile("brands/cloudflare.svg")}
            style={{ width: 58, height: 38, objectFit: "contain" }}
          />
          Harness containers on your account
        </div>
        {BRANDS.map((b, i) => (
          <div
            key={b.name}
            style={{
              position: "absolute",
              left: 35 + i * 544,
              top: 96,
              width: 520,
              height: 336,
              border: `1px solid ${T.line}`,
              borderRadius: 18,
              background: "#fff",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              boxShadow: "0 8px 25px #1a1a1a06",
              ...rise(f, 17 + i * 12, 24, 38),
            }}
          >
            <Img
              src={staticFile("brands/" + b.src)}
              style={{ width: b.size, height: 92, objectFit: "contain" }}
            />
            <div style={{ fontSize: 42, fontWeight: 600, letterSpacing: -1 }}>{b.name}</div>
            <div style={{ fontSize: 23, color: T.muted }}>{b.sub}</div>
            <div
              style={{
                marginTop: 14,
                fontFamily: mono,
                fontSize: 21,
                color: T.blue,
                background: T.pale,
                border: "1px solid #c7d7fc",
                borderRadius: 8,
                padding: "8px 16px",
              }}
            >
              harness: "{b.harness}"
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 830,
          width: 1680,
          fontSize: 33,
          lineHeight: 1.4,
          color: T.ink,
          ...rise(f, 78, 26, 12),
        }}
      >
        They run as themselves, unmodified, against a model you configure.
        <br />
        <span style={{ color: T.muted }}>
          This project supplies the API, the sandbox, the tools and the durability around them.
        </span>
      </div>
      <Footer>
        <span>Native binaries pinned per release · one isolated /workspace per session</span>
      </Footer>
    </Shell>
  );
};
