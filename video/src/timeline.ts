export const FPS = 30;
export const TOTAL = 1440;
export const SHOTS = {
  hook: { from: 0, duration: 120 },
  runtimes: { from: 120, duration: 180 },
  demo: { from: 300, duration: 420 },
  sdk: { from: 720, duration: 240 },
  durable: { from: 960, duration: 240 },
  outro: { from: 1200, duration: 240 },
} as const;

export const SFX = [
  {
    id: "runtime-enter",
    from: SHOTS.runtimes.from + 12,
    duration: 25,
    src: "audio/sweep.mp3",
    volume: 0.12,
  },
  {
    id: "build-click",
    from: SHOTS.demo.from + 93,
    duration: 15,
    src: "audio/click.mp3",
    volume: 0.2,
  },
  {
    id: "download-click",
    from: SHOTS.demo.from + 252,
    duration: 15,
    src: "audio/click.mp3",
    volume: 0.18,
  },
  {
    id: "code-enter",
    from: SHOTS.sdk.from + 44,
    duration: 25,
    src: "audio/sweep.mp3",
    volume: 0.09,
  },
  {
    id: "reload-click",
    from: SHOTS.durable.from + 74,
    duration: 15,
    src: "audio/click.mp3",
    volume: 0.18,
  },
  {
    id: "outro-settle",
    from: SHOTS.outro.from + 16,
    duration: 45,
    src: "audio/settle.mp3",
    volume: 0.11,
  },
];

export const THEME = {
  bg: "#f6f6f4",
  ink: "#1a1a1a",
  blue: "#2563eb",
  muted: "#6b6b67",
  line: "#e1e1de",
  green: "#15803d",
  pale: "#edf2fd",
};
