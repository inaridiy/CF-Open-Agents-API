import { Promo, SCENES } from "./Promo";
import { BGM, FPS, SFX, THEME, TOTAL } from "./timeline";

import "./styles.css";

const TITLES: Record<string, string> = {
  hook: "The Agents API.\nOpen source.\nOn your Cloudflare account.",
  sdk: "Keep the official SDK.",
  map: "Everything behind the URL is yours.",
  runtimes: "The runtimes keep their own loops.",
  compose: "Three things you own.",
  keys: "No container ever sees a key.",
  demo: "One turn, end to end.",
  durable: "Disconnect.\nThe turn keeps running.",
  tools: "More than a shell.",
  outro: "Build on it.",
};

export const WORKBENCH = {
  name: "CF-Open-Agents-API · OSS launch",
  fps: FPS,
  width: 1920,
  height: 1080,
  total: TOTAL,
  background: THEME.bg,
  revision: "2",
  shots: SCENES.map((s) => ({
    ...s,
    label: s.id,
    schema: [{ type: "text", key: "title", label: "Title", default: TITLES[s.id] }],
  })),
  transitions: [],
  captions: [],
  overlays: [],
  sfx: SFX.map((s) => ({ ...s })),
  bgm: [
    {
      from: 0,
      duration: TOTAL,
      src: BGM.src,
      volume: BGM.gain,
      fadeIn: BGM.fadeIn,
      fadeOut: BGM.fadeOut,
    },
  ],
  original: Promo,
};
