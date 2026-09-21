import { Promo, SCENES } from "./Promo";
import { FPS, TOTAL, SFX, THEME } from "./timeline";

import "./styles.css";

export const WORKBENCH = {
  name: "CF-Open-Agents-API · 48s OSS launch",
  fps: FPS,
  width: 1920,
  height: 1080,
  total: TOTAL,
  background: THEME.bg,
  revision: "1",
  shots: SCENES.map((s) => ({
    ...s,
    label: s.id,
    schema: [
      {
        type: "text",
        key: "title",
        label: "Title",
        default: {
          hook: "Run coding agents.",
          runtimes: "Your runtime. Your model.",
          demo: "From a prompt to working files.",
          sdk: "Official SDK.",
          durable: "Reconnect.\nYour session is still there.",
          outro: "Build on it.",
        }[s.id as "hook"],
      },
    ],
  })),
  transitions: [],
  captions: [],
  overlays: [],
  sfx: SFX.map((s) => ({ ...s })),
  bgm: [{ from: 0, duration: TOTAL, src: "audio/music.wav", volume: 0.65 }],
  original: Promo,
};
