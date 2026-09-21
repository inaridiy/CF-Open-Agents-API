import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";

import { THEME as T } from "../timeline";
import { Footer, mono, rise, Shell, Title, v } from "../ui";

type Phase = "map" | "keys";

const CARD_W = 300;
const CARD_H = 232;
const COLS = [510, 830, 1150];
const ROWS = [370, 622];
const BOX = { left: 480, top: 300, width: 1000, height: 640 };

// Row 1: the API and its records. Row 2: the containers and the gateway. The gateway sits
// bottom-right so the only outbound edge (gateway -> provider) is a straight line.
const CARDS = [
  { col: 0, row: 0, name: "AgentWorker", sub: "auth · presets · routes · RPC", tag: "Worker" },
  { col: 1, row: 0, name: "SessionDO", sub: "turns · items · event log", tag: "SQLite" },
  { col: 2, row: 0, name: "R2", sub: "checkpoints · backups · artifacts", tag: "storage" },
  { col: 0, row: 1, name: "Sandbox", sub: "/workspace · shell · files", tag: "Container" },
  { col: 1, row: 1, name: "Harness", sub: "", tag: "Container" },
  { col: 2, row: 1, name: "Model gateway", sub: "provider keys · protocol", tag: "Worker" },
];
const KEEP_IN_KEYS = new Set(["Sandbox", "Harness", "Model gateway"]);

const Side: React.FC<{
  x: number;
  y: number;
  name: string;
  lines: string[];
  dim: number;
  style?: React.CSSProperties;
}> = ({ x, y, name, lines, dim, style }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: 290,
      height: 212,
      border: `1px solid ${T.line}`,
      borderRadius: 18,
      background: "#fff",
      padding: "26px 28px",
      boxShadow: "0 8px 25px #1a1a1a06",
      opacity: dim,
      ...style,
    }}
  >
    <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, marginBottom: 12 }}>
      {name}
    </div>
    {lines.map((l) => (
      <div key={l} style={{ fontSize: 22, color: T.muted, lineHeight: 1.45 }}>
        {l}
      </div>
    ))}
  </div>
);

const Arrow: React.FC<{ x1: number; x2: number; y: number; progress: number; label?: string }> = ({
  x1,
  x2,
  y,
  progress,
  label,
}) => {
  const len = (x2 - x1) * progress;
  return (
    <div style={{ position: "absolute", left: x1, top: y - 1, width: len, height: 3 }}>
      <div style={{ width: "100%", height: 3, background: T.blue, opacity: 0.85 }} />
      <div
        style={{
          position: "absolute",
          right: -2,
          top: -7,
          width: 0,
          height: 0,
          borderTop: "8px solid transparent",
          borderBottom: "8px solid transparent",
          borderLeft: `14px solid ${T.blue}`,
          opacity: progress > 0.95 ? 1 : 0,
        }}
      />
      {label ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: -34,
            width: x2 - x1,
            textAlign: "center",
            fontFamily: mono,
            fontSize: 19,
            color: T.blue,
            whiteSpace: "nowrap",
            opacity: progress > 0.95 ? 1 : 0,
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

const Badge: React.FC<{ children: React.ReactNode; blue?: boolean; opacity: number }> = ({
  children,
  blue,
  opacity,
}) => (
  <div
    style={{
      position: "absolute",
      left: 18,
      right: 18,
      bottom: 16,
      padding: "9px 0",
      borderRadius: 10,
      textAlign: "center",
      fontFamily: mono,
      fontSize: 18,
      letterSpacing: 1,
      textTransform: "uppercase",
      background: blue ? T.pale : "#f3f3f0",
      color: blue ? T.blue : T.ink,
      border: `1px solid ${blue ? "#c7d7fc" : T.line}`,
      opacity,
    }}
  >
    {children}
  </div>
);

/** The account map. In the keys phase everything is already in place and the gateway path
 *  is the only thing lit; the map phase staggers the cards in. */
export const ArchMap: React.FC<{ f: number; phase: Phase }> = ({ f, phase }) => {
  const keys = phase === "keys";
  const at = (i: number) => (keys ? -100 : 14 + i * 9);
  const dimTo = keys ? v(f, 8, 34, 1, 0.22) : 1;
  const badge = keys ? v(f, 30, 54) : 0;
  const inArrow = keys ? 0.001 : v(f, 60, 84);
  const outArrow = keys ? 1 : v(f, 84, 108);
  const midY = ROWS[1] + CARD_H / 2;
  return (
    <>
      <Side
        x={120}
        y={ROWS[0] + 10}
        name="Your application"
        lines={["Official OpenAI SDK", "Service Binding or HTTPS"]}
        dim={keys ? dimTo : 1}
        style={keys ? undefined : rise(f, 0, 24, 18)}
      />
      <Arrow x1={410} x2={BOX.left} y={ROWS[0] + 10 + 106} progress={keys ? 0 : inArrow} />
      <div
        style={{
          position: "absolute",
          ...BOX,
          border: "2px solid #cfdbf5",
          borderRadius: 28,
          background: T.pale,
          opacity: keys ? 1 : v(f, 6, 28),
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 22,
            left: 30,
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 27,
            fontWeight: 560,
          }}
        >
          <Img
            src={staticFile("brands/cloudflare.svg")}
            style={{ width: 58, height: 38, objectFit: "contain" }}
          />
          Your Cloudflare account
        </div>
      </div>
      {CARDS.map((c, i) => {
        const lit = !keys || KEEP_IN_KEYS.has(c.name);
        const isHarness = c.name === "Harness";
        const isGateway = c.name === "Model gateway";
        const noNet = keys && c.name === "Harness";
        const policy = keys && c.name === "Sandbox";
        return (
          <div
            key={c.name}
            style={{
              position: "absolute",
              left: COLS[c.col],
              top: ROWS[c.row],
              width: CARD_W,
              height: CARD_H,
              border: `1px solid ${keys && isGateway ? "#c7d7fc" : T.line}`,
              borderRadius: 18,
              background: "#fff",
              padding: "22px 24px",
              boxShadow: "0 8px 25px #1a1a1a06",
              ...(keys ? { opacity: lit ? 1 : dimTo } : rise(f, at(i), 24, 24)),
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: 17,
                letterSpacing: 1.5,
                color: T.muted,
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              {c.tag}
            </div>
            <div style={{ fontSize: 31, fontWeight: 600, letterSpacing: -0.5 }}>{c.name}</div>
            {isHarness ? (
              <>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
                  {["codex.svg", "claude-code.png", "opencode.svg"].map((s) => (
                    <Img
                      key={s}
                      src={staticFile("brands/" + s)}
                      style={{ width: 38, height: 38, objectFit: "contain" }}
                    />
                  ))}
                </div>
                <div style={{ fontSize: 18, color: T.muted, marginTop: 10, opacity: 1 - badge }}>
                  Codex · Claude Code · OpenCode
                </div>
              </>
            ) : (
              <div style={{ fontSize: 21, color: T.muted, marginTop: 12, lineHeight: 1.4 }}>
                {c.sub}
              </div>
            )}
            {noNet ? <Badge opacity={badge}>no Internet access</Badge> : null}
            {policy ? <Badge opacity={badge}>network per policy</Badge> : null}
            {keys && isGateway ? (
              <Badge blue opacity={badge}>
                holds the keys
              </Badge>
            ) : null}
          </div>
        );
      })}
      {keys ? (
        <div
          style={{
            position: "absolute",
            left: COLS[1] + CARD_W,
            top: midY - 1,
            width: COLS[2] - COLS[1] - CARD_W,
            height: 3,
            background: T.blue,
            opacity: badge,
          }}
        />
      ) : null}
      <Arrow x1={COLS[2] + CARD_W + 2} x2={1540} y={midY} progress={outArrow} />
      <Side
        x={1540}
        y={midY - 106}
        name="Model provider"
        lines={["OpenAI · Anthropic · Workers AI", "any OpenAI-compatible"]}
        dim={1}
        style={keys ? undefined : rise(f, 96, 24, 18)}
      />
    </>
  );
};

export const Map: React.FC<{ title?: string }> = ({
  title = "Everything behind the URL is yours.",
}) => {
  const f = useCurrentFrame();
  return (
    <Shell chapter="02 / YOUR ACCOUNT">
      <Title f={f}>{title}</Title>
      <ArchMap f={f} phase="map" />
      <Footer>
        <span>One Worker exports every class. Each session gets its own objects.</span>
        <span style={{ fontFamily: mono, fontSize: 22 }}>
          Workers · Durable Objects · Containers · R2
        </span>
      </Footer>
    </Shell>
  );
};

export const Keys: React.FC<{ title?: string }> = ({ title = "No container ever sees a key." }) => {
  const f = useCurrentFrame();
  return (
    <Shell chapter="05 / CREDENTIALS">
      <Title f={f}>{title}</Title>
      <ArchMap f={f} phase="keys" />
      <Footer>
        <span style={{ ...rise(f, 60, 24, 8) }}>
          Clients name a preset. They never see a provider URL or a key.
        </span>
        <span style={{ fontFamily: mono, fontSize: 22 }}>model.internal → gateway → provider</span>
      </Footer>
    </Shell>
  );
};
