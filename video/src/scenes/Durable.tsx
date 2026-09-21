import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";

import { THEME as T } from "../timeline";
import { BrowserBar, clamp, Footer, rise, Shell, v } from "../ui";

const RULES = [
  ["One transaction per transition", "Input, turn and events commit together in SQLite."],
  ["An alarm drives the turn", "A dropped connection never loses it."],
  ["A checkpoint seals it", "Native state and /workspace go to R2."],
  ["The next turn resumes", "From the last commit. The sandbox is reused when it still matches."],
];

export const Durable: React.FC<{ title?: string }> = ({
  title = "Disconnect.\nThe turn keeps running.",
}) => {
  const f = useCurrentFrame();
  return (
    <Shell chapter="07 / DURABLE BY DESIGN">
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
        <BrowserBar label="same session · reload while building" />
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
            style={{ width: 1100, height: "auto", translate: `0 ${v(f, 102, 155, 0, -122)}px` }}
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
      <div style={{ position: "absolute", left: 1290, top: 428, width: 510 }}>
        {RULES.map(([a, b], i) => (
          <div
            key={a}
            style={{
              padding: "17px 0 19px",
              borderBottom: `1px solid ${T.line}`,
              ...rise(f, 36 + i * 20, 28, 12),
            }}
          >
            <div style={{ fontSize: 30, fontWeight: 590, marginBottom: 8, letterSpacing: -0.5 }}>
              {a}
            </div>
            <div style={{ fontSize: 24, color: T.muted, lineHeight: 1.35 }}>{b}</div>
          </div>
        ))}
      </div>
      <Footer>
        <span>Streamed from the durable event log, not from a process.</span>
        <span style={{ fontSize: 22 }}>Same job before and after reload</span>
      </Footer>
    </Shell>
  );
};
