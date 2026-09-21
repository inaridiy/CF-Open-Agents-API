# CF-Open-Agents-API launch film

A 48-second, English, 1920×1080, 30fps launch video. Actual Codex / Workers AI demo footage, downloaded runtime marks, editable React scenes, and music/no-music exports.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir video studio
pnpm --dir video render
pnpm --dir video render:no-bgm
pnpm --dir video typecheck
```

`remotion.config.ts` points at the Chromium already installed on the production machine. Set `PROMO_CHROME` to your Chrome/Chromium executable on another machine. Remotion's bundled FFmpeg performs encoding; no system FFmpeg is needed for normal rendering.

Outputs are `out/cf-open-agents-api.mp4` and `out/cf-open-agents-api-no-bgm.mp4`. Both use H.264 with 4:2:0 full-range color (reported as `yuvj420p` by FFprobe) and AAC sound. The second keeps the same sound effects. `out/qa/` holds local frame checks. `reference/capture/` preserves the real-run provenance and artifact ZIP, and `VALIDATION.md` summarizes the checks and their limits.

Edit `src/Scenes.tsx` for composition and text, `src/timeline.ts` for the sole timing table, and `src/workbench.ts` for the visual editor manifest. Each scene is separately registered in Studio. Shared typography is in `src/styles.css`.

To inspect keyframes:

```sh
cd video
node scripts/stills.mjs
```

The screenshots and generated game are already included, so rendering makes no provider calls. Recapturing **does** create a new Workers AI job; only run `scripts/capture-demo.mjs` against an authorized local demo. The recorded environment was `/home/inaridiy/open-agents-api-test`, started with `pnpm dev:rootless`. `capture-game.mjs` exercises the downloaded HTML's win, reset, and draw behavior.

`DESIGN.md` contains the approved storyboard and implementation choices. `ASSETS.md` and `assets.json` record third-party media. `scripts/fetch-assets.mjs` restores downloaded logos/fonts/SFX and rejects changed upstream checksums. The music mix is included as `public/audio/music.wav`; its source and edit are documented in ASSETS.md.

The Shotcraft workbench can import `src/workbench.ts` to edit scenes, text and audio on a timeline. Native Remotion Studio is also available through the `studio` command above.
