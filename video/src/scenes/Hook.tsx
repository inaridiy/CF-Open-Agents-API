import React from "react";
import { useCurrentFrame } from "remotion";

import { THEME as T } from "../timeline";
import { Chip, Eyebrow, Footer, Shell, v } from "../ui";

export const Hook: React.FC<{ title?: string }> = ({
  title = "The Agents API.\nOpen source.\nOn your Cloudflare account.",
}) => {
  const f = useCurrentFrame();
  const lines = title.split("\n");
  return (
    <Shell>
      <Eyebrow>An unofficial implementation of the OpenAI Agents API · agents=v1</Eyebrow>
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
        {lines.map((line, i) => (
          <div
            key={line}
            style={{
              color: i === lines.length - 1 ? T.blue : T.ink,
              opacity: v(f, i * 9, 22 + i * 9),
              translate: `0 ${v(f, i * 9, 28 + i * 9, 32, 0)}px`,
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
          width: v(f, 34, 80, 0, 925),
          height: 5,
          background: T.blue,
          opacity: 0.7,
        }}
      />
      <Footer>
        <span style={{ opacity: v(f, 40, 62) }}>
          Keep the official OpenAI SDK. Own everything behind it.
        </span>
        <Chip blue>Apache-2.0</Chip>
      </Footer>
    </Shell>
  );
};
