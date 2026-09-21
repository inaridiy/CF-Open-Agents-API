import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";

import { PageCam } from "./lib/PageCam";
import { THEME as T } from "./timeline";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const mono = '"JetBrains Mono", monospace';
const font = "Inter, system-ui, sans-serif";
const v = (f: number, a: number, b: number, x = 0, y = 1) =>
  interpolate(f, [a, b], [x, y], { ...clamp, easing: ease });

export const Shell: React.FC<React.PropsWithChildren<{ chapter?: string }>> = ({
  children,
  chapter,
}) => (
  <AbsoluteFill style={{ background: T.bg, color: T.ink, fontFamily: font }}>
    <div
      style={{
        position: "absolute",
        left: 96,
        right: 96,
        top: 58,
        height: 46,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 24,
        fontWeight: 600,
      }}
    >
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <span style={{ color: T.blue, fontFamily: mono, fontWeight: 800, fontSize: 27 }}>cf /</span>
        <span>CF-Open-Agents-API</span>
      </div>
      <div style={{ fontFamily: mono, fontSize: 21, color: T.muted }}>
        {chapter ?? "OPEN SOURCE · ALPHA"}
      </div>
    </div>
    <div
      style={{ position: "absolute", left: 96, right: 96, top: 126, height: 1, background: T.line }}
    />
    {children}
  </AbsoluteFill>
);

const Eyebrow: React.FC<React.PropsWithChildren<{ top?: number }>> = ({ children, top = 188 }) => (
  <div
    style={{
      position: "absolute",
      left: 120,
      top,
      fontFamily: mono,
      fontSize: 22,
      letterSpacing: 2,
      color: T.blue,
      textTransform: "uppercase",
    }}
  >
    {children}
  </div>
);
const Footer: React.FC<React.PropsWithChildren> = ({ children }) => (
  <div
    style={{
      position: "absolute",
      left: 120,
      right: 120,
      bottom: 58,
      fontSize: 25,
      color: T.muted,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    }}
  >
    {children}
  </div>
);
const Chip: React.FC<React.PropsWithChildren<{ blue?: boolean }>> = ({
  children,
  blue = false,
}) => (
  <span
    style={{
      padding: "12px 21px",
      border: `1px solid ${blue ? "#c7d7fc" : T.line}`,
      borderRadius: 100,
      background: blue ? T.pale : "#fff",
      fontSize: 24,
      color: blue ? T.blue : T.ink,
    }}
  >
    {children}
  </span>
);

export const Hook: React.FC<{ title?: string; accent?: string }> = ({
  title = "Run coding agents.",
  accent = "On your own\nCloudflare account.",
}) => {
  const f = useCurrentFrame();
  return (
    <Shell>
      <Eyebrow>Native runtimes. An API you host.</Eyebrow>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 283,
          fontSize: 112,
          fontWeight: 620,
          letterSpacing: -6,
          lineHeight: 1.12,
        }}
      >
        <div style={{ opacity: v(f, 0, 20), translate: `0 ${v(f, 0, 26, 30, 0)}px` }}>{title}</div>
        {accent.split("\n").map((line, i) => (
          <div
            key={line}
            style={{
              color: i === 1 ? T.blue : T.ink,
              opacity: v(f, 10 + i * 9, 32 + i * 9),
              translate: `0 ${v(f, 10 + i * 9, 36 + i * 9, 35, 0)}px`,
            }}
          >
            {line}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 126,
          top: 743,
          width: v(f, 32, 76, 0, 925),
          height: 5,
          background: T.blue,
          opacity: 0.7,
        }}
      />
      <Footer>
        <span>An independent Agents API implementation.</span>
        <Chip blue>Apache-2.0</Chip>
      </Footer>
    </Shell>
  );
};

export const Runtimes: React.FC<{ title?: string }> = ({ title = "Your runtime. Your model." }) => {
  const f = useCurrentFrame();
  const brands = [
    { name: "Codex", src: "codex.svg", sub: "OpenAI", size: 91 },
    { name: "Claude Code", src: "claude-code.png", sub: "Anthropic", size: 108 },
    { name: "OpenCode", src: "opencode.svg", sub: "Open source", size: 100 },
  ];
  return (
    <Shell chapter="01 / CHOOSE YOUR RUNTIME">
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 204,
          fontSize: 78,
          fontWeight: 620,
          letterSpacing: -3,
          opacity: v(f, 0, 18),
        }}
      >
        {title}
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 360,
          width: 1680,
          height: 456,
          border: "2px solid #cfdbf5",
          borderRadius: 28,
          background: T.pale,
          opacity: v(f, 8, 30),
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 26,
            left: 36,
            display: "flex",
            alignItems: "center",
            gap: 20,
            fontSize: 28,
            fontWeight: 560,
          }}
        >
          <Img
            src={staticFile("brands/cloudflare.svg")}
            style={{ width: 61, height: 40, objectFit: "contain" }}
          />
          Your Cloudflare account
        </div>
        {brands.map((b, i) => (
          <div
            key={b.name}
            style={{
              position: "absolute",
              left: 35 + i * 544,
              top: 112,
              width: 520,
              height: 287,
              border: `1px solid ${T.line}`,
              borderRadius: 18,
              background: "#fff",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              boxShadow: "0 8px 25px #1a1a1a06",
              opacity: v(f, 17 + i * 12, 41 + i * 12),
              translate: `0 ${v(f, 17 + i * 12, 50 + i * 12, 38, 0)}px`,
            }}
          >
            <Img
              src={staticFile("brands/" + b.src)}
              style={{ width: b.size, height: 95, objectFit: "contain" }}
            />
            <div style={{ fontSize: 43, fontWeight: 600, letterSpacing: -1 }}>{b.name}</div>
            <div style={{ fontSize: 23, color: T.muted }}>{b.sub}</div>
          </div>
        ))}
      </div>
      <Footer>
        <span>Native agent loops · isolated workspaces</span>
        <span style={{ fontFamily: mono, fontSize: 23 }}>Models you configure →</span>
      </Footer>
    </Shell>
  );
};

const Cursor: React.FC<{ x: number; y: number; click?: number }> = ({ x, y, click = 0 }) => (
  <div style={{ position: "absolute", left: x, top: y, zIndex: 6 }}>
    {click > 0 && click < 1 ? (
      <div
        style={{
          position: "absolute",
          width: 64,
          height: 64,
          border: `3px solid ${T.blue}`,
          borderRadius: 100,
          translate: "-50% -50%",
          scale: 0.3 + 1.6 * click,
          opacity: 1 - click,
        }}
      />
    ) : null}
    <svg
      width="42"
      height="52"
      viewBox="0 0 24 30"
      style={{ filter: "drop-shadow(0 3px 4px #0003)" }}
    >
      <path
        d="M3 2 L3 24 L9 18 L14 28 L18 26 L13 16 L22 16 Z"
        fill="#1a1a1a"
        stroke="#fff"
        strokeWidth="1.6"
      />
    </svg>
  </div>
);

const BrowserBar: React.FC<{ label: string }> = ({ label }) => (
  <div
    style={{
      height: 60,
      background: "#fff",
      borderBottom: `1px solid ${T.line}`,
      display: "flex",
      alignItems: "center",
      padding: "0 28px",
      gap: 11,
    }}
  >
    {[0, 1, 2].map((i) => (
      <span key={i} style={{ height: 10, width: 10, borderRadius: 10, background: "#dadad5" }} />
    ))}
    <span style={{ fontFamily: mono, fontSize: 20, color: T.muted, marginLeft: 32 }}>{label}</span>
  </div>
);

export const Demo: React.FC<{ title?: string }> = ({
  title = "From a prompt to working files.",
}) => {
  const f = useCurrentFrame();
  let stage = 2;
  if (f < 106) stage = 0;
  else if (f < 272) stage = 1;
  let gameTexture = "textures/game-win.png";
  if (f < 317) gameTexture = "textures/game-start.png";
  else if (f < 353) gameTexture = "textures/game-play.png";
  return (
    <Shell chapter="02 / A REAL BUILD">
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 185,
          fontSize: 70,
          fontWeight: 610,
          letterSpacing: -3,
        }}
      >
        {stage === 2 ? "A real file. Ready to open." : title}
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 304,
          width: 1680,
          height: 656,
          background: "#fff",
          border: `1px solid ${T.line}`,
          borderRadius: 20,
          overflow: "hidden",
          boxShadow: "0 22px 60px #1a1a1a09",
          opacity: v(f, 0, 16),
        }}
      >
        <BrowserBar
          label={
            stage === 2
              ? "tic-tac-toe.html · downloaded artifact"
              : "Agent Builder · local demo on Workers AI"
          }
        />
        {stage === 0 ? (
          <div
            style={{
              position: "absolute",
              top: 79,
              left: 135,
              width: 1410,
              height: 565,
              overflow: "hidden",
            }}
          >
            <Img
              src={staticFile("textures/home-form.png")}
              style={{ width: 1410, height: "auto" }}
            />
            <Cursor x={v(f, 55, 88, 1050, 1337)} y={v(f, 55, 88, 205, 378)} click={v(f, 93, 106)} />
          </div>
        ) : null}
        {stage === 1 ? (
          <div
            style={{
              position: "absolute",
              top: 60,
              left: 0,
              right: 0,
              bottom: 0,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: 1920,
                height: 1080,
                scale: 0.875,
                transformOrigin: "0 0",
              }}
            >
              <PageCam
                src="textures/job-action.png"
                pageH={2133}
                keys={[
                  { frame: 106, cx: 960, cy: 1300, zoom: 1.65 },
                  { frame: 165, cx: 960, cy: 1300, zoom: 1.65 },
                  { frame: 206, cx: 960, cy: 1530, zoom: 1.65 },
                  { frame: 238, cx: 960, cy: 1530, zoom: 1.65 },
                ]}
                frame={f}
              />
            </div>
            {f >= 220 ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: T.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Img
                  src={staticFile("textures/job-done-outputs.png")}
                  style={{ width: 1360, height: "auto" }}
                />
                <Cursor
                  x={v(f, 225, 248, 600, 410)}
                  y={v(f, 225, 248, 180, 365)}
                  click={v(f, 252, 268)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {stage === 2 ? (
          <div
            style={{
              position: "absolute",
              top: 60,
              left: 0,
              width: 1680,
              height: 596,
              overflow: "hidden",
              background: T.bg,
            }}
          >
            <div style={{ position: "absolute", left: 95, top: 144, width: 555 }}>
              <div style={{ fontFamily: mono, fontSize: 30, color: T.blue, marginBottom: 25 }}>
                tic-tac-toe.html
              </div>
              <div style={{ fontSize: 49, fontWeight: 570, letterSpacing: -2, lineHeight: 1.25 }}>
                Built in the sandbox.
                <br />
                Opened in a browser.
              </div>
              <div style={{ fontSize: 29, color: T.muted, marginTop: 24 }}>
                One file. No dependencies.
              </div>
            </div>
            <Img
              src={staticFile(gameTexture)}
              style={{
                position: "absolute",
                left: 630,
                width: 1050,
                height: "100%",
                objectFit: "contain",
              }}
            />
          </div>
        ) : null}
      </div>
      <Footer>
        <span style={{ fontSize: 22 }}>Codex runtime · Workers AI model</span>
        <span style={{ fontSize: 22 }}>Recorded demo · Edited for length</span>
      </Footer>
    </Shell>
  );
};

// Adapted from Shotcraft TypingCodeBlock's line reveal. Token colours exist
// before entrance; 19f staggering, 8px translation, cubic easing, stable line boxes.
const K = T.blue,
  ID = T.ink,
  ST = "#15803d";
const CODE: [string, string][][] = [
  [
    ["import ", K],
    ["OpenAI", ID],
    [" from ", K],
    ['"openai"', ST],
    [";", ID],
  ],
  [
    ["const ", K],
    ["client", ID],
    [" = new ", K],
    ["OpenAI", ID],
    ["({", ID],
  ],
  [
    ["  baseURL: ", ID],
    ['"https://your-worker.workers.dev/v1"', ST],
    [",", ID],
  ],
  [
    ["  apiKey: ", ID],
    ["process.env.AGENT_API_TOKEN", ID],
    [",", ID],
  ],
  [["});", ID]],
];

export const SDK: React.FC<{ title?: string }> = ({ title = "Official SDK." }) => {
  const f = useCurrentFrame();
  const dem = interpolate(f, [32, 52], [0, 1], {
    ...clamp,
    easing: Easing.inOut((t) => Easing.cubic(t)),
  });
  return (
    <Shell chapter="03 / CONNECT YOUR APP">
      <div
        style={{
          position: "absolute",
          left: interpolate(dem, [0, 1], [960, 120]),
          top: interpolate(dem, [0, 1], [425, 230]),
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
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 321,
          width: 1680,
          height: 515,
          border: `1px solid ${T.line}`,
          background: "#fff",
          borderRadius: 20,
          overflow: "hidden",
          opacity: v(f, 44, 68),
          translate: `0 ${v(f, 44, 74, 28, 0)}px`,
        }}
      >
        <div
          style={{
            height: 65,
            borderBottom: `1px solid ${T.line}`,
            padding: "20px 34px",
            fontFamily: mono,
            fontSize: 21,
            color: T.muted,
          }}
        >
          app.ts <span style={{ float: "right" }}>YOUR WORKER ENDPOINT</span>
        </div>
        <div
          style={{
            padding: "29px 41px",
            fontFamily: mono,
            fontSize: 34,
            lineHeight: 1.85,
            whiteSpace: "pre",
          }}
        >
          {CODE.map((line, i) => (
            <div
              key={i}
              style={{
                minHeight: "1.85em",
                opacity: interpolate(f, [61 + i * 19, 102 + i * 19], [0, 1], {
                  ...clamp,
                  easing: Easing.out((t) => Easing.cubic(t)),
                }),
                translate: `0 ${interpolate(f, [61 + i * 19, 102 + i * 19], [8, 0], { ...clamp, easing: Easing.out((t) => Easing.cubic(t)) })}px`,
              }}
            >
              <span style={{ color: "#b6b6b1", display: "inline-block", width: 64, fontSize: 25 }}>
                {i + 1}
              </span>
              {line.map(([text, color], j) => (
                <span key={j} style={{ color }}>
                  {text}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 875,
          fontSize: 36,
          color: T.muted,
          opacity: v(f, 130, 155),
        }}
      >
        Sessions. Turns. Streaming. Files.
      </div>
      <Footer>
        <span>Use the official OpenAI SDK.</span>
        <span style={{ fontFamily: mono, fontSize: 22 }}>
          Agents API · alpha compatibility profile
        </span>
      </Footer>
    </Shell>
  );
};

export const Durable: React.FC<{ title?: string }> = ({
  title = "Reconnect.\nYour session is still there.",
}) => {
  const f = useCurrentFrame();
  return (
    <Shell chapter="04 / DURABLE SESSIONS">
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 198,
          fontSize: 74,
          fontWeight: 610,
          letterSpacing: -3,
          lineHeight: 1.16,
        }}
      >
        {title.split("\n").map((line, i) => (
          <div key={line} style={{ color: i ? T.blue : T.ink, opacity: v(f, i * 8, 18 + i * 8) }}>
            {line}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 430,
          width: 1100,
          height: 488,
          border: `1px solid ${T.line}`,
          background: "#fff",
          borderRadius: 18,
          overflow: "hidden",
        }}
      >
        <BrowserBar label="same session · reload" />
        <div
          style={{
            position: "absolute",
            right: 25,
            top: 18,
            fontSize: 25,
            rotate: `${interpolate(f, [74, 100], [0, 360], clamp)}deg`,
            color: T.blue,
          }}
        >
          ↻
        </div>
        <div
          style={{
            position: "absolute",
            top: 60,
            left: 0,
            width: 1100,
            height: 428,
            overflow: "hidden",
          }}
        >
          <Img
            src={staticFile(
              f < 86 ? "textures/reconnect-before-main.png" : "textures/reconnect-after-main.png",
            )}
            style={{ width: 1100, height: "auto", translate: `0 ${v(f, 102, 155, 0, -60)}px` }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: T.bg,
              opacity: interpolate(f, [74, 80, 86, 96], [0, 0.9, 0.9, 0], clamp),
            }}
          />
        </div>
      </div>
      <div style={{ position: "absolute", left: 1290, top: 448, width: 500 }}>
        {[
          ["Session state", "SQLite Durable Objects"],
          ["Checkpoints", "R2 storage"],
          ["Provider keys", "Held by your Worker"],
        ].map(([a, b], i) => (
          <div
            key={a}
            style={{
              padding: "21px 0 25px",
              borderBottom: `1px solid ${T.line}`,
              opacity: v(f, 38 + i * 22, 66 + i * 22),
              translate: `0 ${v(f, 38 + i * 22, 66 + i * 22, 12, 0)}px`,
            }}
          >
            <div style={{ fontSize: 33, fontWeight: 580, marginBottom: 12 }}>{a}</div>
            <div style={{ fontSize: 27, color: T.muted }}>{b}</div>
          </div>
        ))}
      </div>
      <Footer>
        <span>A connection ends. The work persists.</span>
        <span style={{ fontSize: 22 }}>Same job before and after reload</span>
      </Footer>
    </Shell>
  );
};

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
          top: 268,
          fontSize: 123,
          fontWeight: 620,
          letterSpacing: -6,
          opacity: v(f, 0, 22),
          translate: `0 ${v(f, 0, 28, 30, 0)}px`,
        }}
      >
        {title}
      </div>
      <div
        style={{
          position: "absolute",
          left: 124,
          top: 437,
          fontSize: 56,
          fontWeight: 530,
          letterSpacing: -2,
          opacity: v(f, 14, 36),
        }}
      >
        CF-Open-Agents-API
      </div>
      <div
        style={{
          position: "absolute",
          left: 124,
          top: 541,
          display: "flex",
          gap: 14,
          opacity: v(f, 24, 47),
        }}
      >
        <Chip blue>Open source</Chip>
        <Chip>Apache-2.0</Chip>
        <Chip>Alpha</Chip>
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 654,
          width: 1680,
          height: 132,
          background: "#fff",
          border: `1px solid ${T.line}`,
          borderRadius: 18,
          display: "flex",
          alignItems: "center",
          padding: "0 36px",
          gap: 29,
          opacity: v(f, 30, 56),
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
          top: 839,
          fontSize: 36,
          color: T.blue,
          opacity: v(f, 44, 68),
        }}
      >
        {cta}
      </div>
      <Footer>
        <span style={{ fontSize: 23 }}>
          Independent implementation. Not affiliated with the runtime vendors or Cloudflare.
        </span>
      </Footer>
    </Shell>
  );
};
