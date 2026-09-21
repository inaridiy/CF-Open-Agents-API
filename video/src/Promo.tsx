import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile } from "remotion";

import { Compose, Demo, Durable, Hook, Keys, Map, Outro, Runtimes, SDK, Tools } from "./Scenes";
import { BGM, SFX, SHOTS, THEME, TOTAL } from "./timeline";

export const SCENES = [
  { id: "hook", component: Hook, ...SHOTS.hook },
  { id: "sdk", component: SDK, ...SHOTS.sdk },
  { id: "map", component: Map, ...SHOTS.map },
  { id: "runtimes", component: Runtimes, ...SHOTS.runtimes },
  { id: "compose", component: Compose, ...SHOTS.compose },
  { id: "keys", component: Keys, ...SHOTS.keys },
  { id: "demo", component: Demo, ...SHOTS.demo },
  { id: "durable", component: Durable, ...SHOTS.durable },
  { id: "tools", component: Tools, ...SHOTS.tools },
  { id: "outro", component: Outro, ...SHOTS.outro },
];

const bgmVolume = (f: number) =>
  BGM.gain *
  interpolate(f, [0, BGM.fadeIn, TOTAL - BGM.fadeOut, TOTAL], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const Promo: React.FC<{ bgm?: boolean }> = ({ bgm = true }) => (
  <AbsoluteFill style={{ background: THEME.bg }}>
    {SCENES.map(({ id, component: Scene, from, duration }) => (
      <Sequence key={id} from={from} durationInFrames={duration} name={id}>
        <Scene />
      </Sequence>
    ))}
    {bgm ? <Audio src={staticFile(BGM.src)} volume={bgmVolume} endAt={TOTAL} /> : null}
    {SFX.map((s) => (
      <Sequence key={s.id} from={s.from} durationInFrames={s.duration} name={s.id}>
        <Audio src={staticFile(s.src)} volume={s.volume} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
