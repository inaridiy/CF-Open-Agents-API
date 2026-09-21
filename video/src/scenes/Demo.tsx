import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";

import { PageCam } from "../lib/PageCam";
import { THEME as T } from "../timeline";
import { BrowserBar, Cursor, Footer, mono, Shell, Title, v } from "../ui";

// Real Codex + Workers AI run, compressed. Stage 0: prompt and Build. Stage 1: the job page
// streaming shell/thinking cards, then the outputs card and the zip download. Stage 2: the
// downloaded file opened in a browser.
export const Demo: React.FC<{ title?: string }> = ({ title = "One turn, end to end." }) => {
  const f = useCurrentFrame();
  let stage = 2;
  if (f < 80) stage = 0;
  else if (f < 220) stage = 1;
  let gameTexture = "textures/game-win.png";
  if (f < 255) gameTexture = "textures/game-start.png";
  else if (f < 285) gameTexture = "textures/game-play.png";
  return (
    <Shell chapter="06 / A REAL TURN">
      <Title f={f} at={stage === 2 ? 220 : 0}>
        {stage === 2 ? "The files it wrote, published as artifacts." : title}
      </Title>
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
            <Cursor x={v(f, 28, 60, 1050, 1337)} y={v(f, 28, 60, 205, 378)} click={v(f, 66, 79)} />
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
                  { frame: 80, cx: 960, cy: 1300, zoom: 1.65 },
                  { frame: 125, cx: 960, cy: 1300, zoom: 1.65 },
                  { frame: 160, cx: 960, cy: 1530, zoom: 1.65 },
                  { frame: 185, cx: 960, cy: 1530, zoom: 1.65 },
                ]}
                frame={f}
              />
            </div>
            {f >= 172 ? (
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
                  x={v(f, 176, 196, 600, 410)}
                  y={v(f, 176, 196, 180, 365)}
                  click={v(f, 199, 213)}
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
            <div style={{ position: "absolute", left: 95, top: 130, width: 600 }}>
              <div style={{ fontFamily: mono, fontSize: 25, color: T.blue, marginBottom: 25 }}>
                /workspace/outputs/tic-tac-toe.html
              </div>
              <div style={{ fontSize: 49, fontWeight: 570, letterSpacing: -2, lineHeight: 1.25 }}>
                Written in the sandbox.
                <br />
                Sealed by a checkpoint.
                <br />
                Opened in a browser.
              </div>
              <div style={{ fontSize: 28, color: T.muted, marginTop: 24 }}>
                One file. No dependencies. 5,593 bytes.
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
        <span style={{ fontSize: 23 }}>Codex runtime · Workers AI model · a local demo</span>
        <span style={{ fontSize: 23 }}>Recorded demo · Edited for length</span>
      </Footer>
    </Shell>
  );
};
