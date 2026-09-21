import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";

import { Hook, Runtimes, Demo, SDK, Durable, Outro } from "./Scenes";
import { SHOTS, SFX, THEME } from "./timeline";

export const SCENES = [
  { id: "hook", component: Hook, ...SHOTS.hook },
  { id: "runtimes", component: Runtimes, ...SHOTS.runtimes },
  { id: "demo", component: Demo, ...SHOTS.demo },
  { id: "sdk", component: SDK, ...SHOTS.sdk },
  { id: "durable", component: Durable, ...SHOTS.durable },
  { id: "outro", component: Outro, ...SHOTS.outro },
];
export const Promo: React.FC<{ bgm?: boolean }> = ({ bgm = true }) => (
  <AbsoluteFill style={{ background: THEME.bg }}>
    {SCENES.map(({ id, component: Scene, from, duration }) => (
      <Sequence key={id} from={from} durationInFrames={duration} name={id}>
        <Scene />
      </Sequence>
    ))}
    {bgm ? <Audio src={staticFile("audio/music.wav")} volume={0.65} /> : null}
    {SFX.map((s) => (
      <Sequence key={s.id} from={s.from} durationInFrames={s.duration} name={s.id}>
        <Audio src={staticFile(s.src)} volume={s.volume} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
