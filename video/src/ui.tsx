import React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";

import { THEME as T } from "./timeline";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const mono = '"JetBrains Mono", monospace';
export const font = "Inter, system-ui, sans-serif";
/** Eased ramp: x at frame a, y at frame b, clamped outside. */
export const v = (f: number, a: number, b: number, x = 0, y = 1) =>
  interpolate(f, [a, b], [x, y], { ...clamp, easing: ease });
/** Fade + 12px rise entrance, as a style fragment. */
export const rise = (f: number, at: number, len = 26, px = 14) => ({
  opacity: v(f, at, at + len),
  translate: `0 ${v(f, at, at + len + 6, px, 0)}px`,
});

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

export const Title: React.FC<
  React.PropsWithChildren<{ f: number; top?: number; size?: number; at?: number }>
> = ({ children, f, top = 185, size = 70, at = 0 }) => (
  <div
    style={{
      position: "absolute",
      left: 120,
      top,
      fontSize: size,
      fontWeight: 610,
      letterSpacing: -size * 0.04,
      lineHeight: 1.14,
      whiteSpace: "pre",
      ...rise(f, at, 20, 18),
    }}
  >
    {children}
  </div>
);

export const Eyebrow: React.FC<React.PropsWithChildren<{ top?: number }>> = ({
  children,
  top = 188,
}) => (
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

export const Footer: React.FC<React.PropsWithChildren> = ({ children }) => (
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

export const Chip: React.FC<React.PropsWithChildren<{ blue?: boolean; monoText?: boolean }>> = ({
  children,
  blue = false,
  monoText = false,
}) => (
  <span
    style={{
      padding: "12px 21px",
      border: `1px solid ${blue ? "#c7d7fc" : T.line}`,
      borderRadius: 100,
      background: blue ? T.pale : "#fff",
      fontSize: monoText ? 22 : 24,
      fontFamily: monoText ? mono : font,
      color: blue ? T.blue : T.ink,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);

export const Cursor: React.FC<{ x: number; y: number; click?: number }> = ({ x, y, click = 0 }) => (
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

export const BrowserBar: React.FC<{ label: string }> = ({ label }) => (
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

// --- Code panel -----------------------------------------------------------
// Adapted from Shotcraft TypingCodeBlock's line reveal: token colours exist before
// entrance, per-line stagger, 8px travel, cubic easing, stable line boxes.
const KW = /^(import|from|export|const|new|await|for|of|if|return|default|async)$/;
const TOKEN = /("(?:[^"\\]|\\.)*"|\/\/.*$|\/\*.*?\*\/|[A-Za-z_$][\w$]*|\s+|[^\sA-Za-z_$"]+)/g;
export const tokenize = (line: string): [string, string][] =>
  Array.from(line.matchAll(TOKEN), (m) => {
    const t = m[0];
    let c: string = T.ink;
    if (t.startsWith('"')) c = T.green;
    else if (t.startsWith("//") || t.startsWith("/*")) c = T.muted;
    else if (KW.test(t)) c = T.blue;
    return [t, c];
  });

export type Note = { line: number; text: string; at: number };
export const CodePanel: React.FC<{
  f: number;
  lines: string[];
  from: number;
  stagger?: number;
  fontSize?: number;
  lineHeight?: number;
  top: number;
  height: number;
  header: string;
  headerRight?: string;
  notes?: Note[];
  enter?: number;
}> = ({
  f,
  lines,
  from,
  stagger = 9,
  fontSize = 26,
  lineHeight = 1.55,
  top,
  height,
  header,
  headerRight,
  notes = [],
  enter = from - 17,
}) => {
  const cubic = Easing.out((t: number) => Easing.cubic(t));
  const lh = fontSize * lineHeight;
  return (
    <div
      style={{
        position: "absolute",
        left: 120,
        top,
        width: 1680,
        height,
        border: `1px solid ${T.line}`,
        background: "#fff",
        borderRadius: 20,
        overflow: "hidden",
        opacity: v(f, enter, enter + 24),
        translate: `0 ${v(f, enter, enter + 30, 28, 0)}px`,
      }}
    >
      <div
        style={{
          height: 62,
          borderBottom: `1px solid ${T.line}`,
          padding: "19px 34px",
          fontFamily: mono,
          fontSize: 21,
          color: T.muted,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{header}</span>
        <span>{headerRight}</span>
      </div>
      <div
        style={{
          position: "relative",
          padding: "22px 40px",
          fontFamily: mono,
          fontSize,
          lineHeight: `${lh}px`,
          whiteSpace: "pre",
        }}
      >
        {lines.map((line, i) => {
          const a = from + i * stagger;
          const o = interpolate(f, [a, a + 41], [0, 1], { ...clamp, easing: cubic });
          const y = interpolate(f, [a, a + 41], [8, 0], { ...clamp, easing: cubic });
          return (
            <div key={i} style={{ height: lh, opacity: o, translate: `0 ${y}px` }}>
              <span
                style={{
                  color: "#b6b6b1",
                  display: "inline-block",
                  width: 58,
                  fontSize: fontSize * 0.75,
                }}
              >
                {i + 1}
              </span>
              {tokenize(line).map(([text, color], j) => (
                <span key={j} style={{ color }}>
                  {text}
                </span>
              ))}
            </div>
          );
        })}
        {notes.map((n) => (
          <div
            key={n.line}
            style={{
              position: "absolute",
              right: 40,
              top: 22 + (n.line - 1) * lh,
              height: lh,
              display: "flex",
              alignItems: "center",
              gap: 14,
              fontFamily: mono,
              fontSize: 21,
              letterSpacing: 1,
              color: T.blue,
              textTransform: "uppercase",
              opacity: v(f, n.at, n.at + 20),
              translate: `${v(f, n.at, n.at + 26, 10, 0)}px 0`,
            }}
          >
            <span style={{ width: 34, height: 1, background: T.blue, display: "inline-block" }} />
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
};
