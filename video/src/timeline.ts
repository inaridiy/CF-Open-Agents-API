export const FPS = 30;

// The sole timing table. Frames are absolute within the Promo composition.
const order = [
  ["hook", 135],
  ["sdk", 255],
  ["map", 225],
  ["runtimes", 180],
  ["compose", 255],
  ["keys", 180],
  ["demo", 330],
  ["durable", 240],
  ["tools", 165],
  ["outro", 210],
] as const;

type ShotId = (typeof order)[number][0];
const build = () => {
  let from = 0;
  const shots = {} as Record<ShotId, { from: number; duration: number }>;
  for (const [id, duration] of order) {
    shots[id] = { from, duration };
    from += duration;
  }
  return { shots, total: from };
};
const built = build();
export const SHOTS = built.shots;
export const TOTAL = built.total; // 2175 frames = 72.5 s

export const SFX = [
  {
    id: "code-enter",
    from: SHOTS.sdk.from + 40,
    duration: 25,
    src: "audio/sweep.mp3",
    volume: 0.09,
  },
  {
    id: "map-enter",
    from: SHOTS.map.from + 12,
    duration: 25,
    src: "audio/sweep.mp3",
    volume: 0.12,
  },
  {
    id: "runtime-enter",
    from: SHOTS.runtimes.from + 12,
    duration: 25,
    src: "audio/sweep.mp3",
    volume: 0.1,
  },
  {
    id: "compose-enter",
    from: SHOTS.compose.from + 20,
    duration: 25,
    src: "audio/sweep.mp3",
    volume: 0.09,
  },
  {
    id: "build-click",
    from: SHOTS.demo.from + 66,
    duration: 15,
    src: "audio/click.mp3",
    volume: 0.2,
  },
  {
    id: "download-click",
    from: SHOTS.demo.from + 199,
    duration: 15,
    src: "audio/click.mp3",
    volume: 0.18,
  },
  {
    id: "reload-click",
    from: SHOTS.durable.from + 74,
    duration: 15,
    src: "audio/click.mp3",
    volume: 0.18,
  },
  {
    id: "tools-enter",
    from: SHOTS.tools.from + 10,
    duration: 25,
    src: "audio/sweep.mp3",
    volume: 0.1,
  },
  {
    id: "outro-settle",
    from: SHOTS.outro.from + 16,
    duration: 45,
    src: "audio/settle.mp3",
    volume: 0.11,
  },
];

// House Vibez (Mixkit 745) played from its start. The same edit as before, applied in the
// timeline instead of a pre-baked WAV: gain 0.32 x 0.65, 1.2 s linear fade-in, 3 s fade-out.
export const BGM = { src: "audio/music.mp3", gain: 0.32 * 0.65, fadeIn: 36, fadeOut: 90 };

export const THEME = {
  bg: "#f6f6f4",
  ink: "#1a1a1a",
  blue: "#2563eb",
  muted: "#6b6b67",
  line: "#e1e1de",
  green: "#15803d",
  pale: "#edf2fd",
  orange: "#c2410c",
};
