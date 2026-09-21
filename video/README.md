# CF-Open-Agents-API launch film

A 72.5-second, English, 1920×1080, 30fps launch video in ten chapters. Actual Codex / Workers AI demo footage, downloaded runtime marks, editable React scenes, and music/no-music exports.

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

`src/timeline.ts` is the sole timing table: chapter order and durations, the sound-effect cues and the music edit. `src/scenes/` holds one file per chapter (composition, copy and motion); `src/ui.tsx` holds the shared shell, code panel and cursor; `src/Scenes.tsx` re-exports the chapters and `src/workbench.ts` is the visual editor manifest. Each scene is separately registered in Studio. Shared typography is in `src/styles.css`.

To inspect keyframes:

```sh
cd video
node scripts/stills.mjs            # the default keyframe list
node scripts/stills.mjs 540 1160   # specific frames
```

The screenshots and generated game are already included, so rendering makes no provider calls. Recapturing **does** create a new Workers AI job; only run `scripts/capture-demo.mjs` against an authorized local demo. The recorded environment was `/home/inaridiy/open-agents-api-test`, started with `pnpm dev:rootless`. `capture-game.mjs` exercises the downloaded HTML's win, reset, and draw behavior.

`DESIGN.md` contains the storyboard and implementation choices. `ASSETS.md` and `assets.json` record third-party media, the music track included. `scripts/fetch-assets.mjs` restores downloaded logos/fonts/SFX/music and rejects changed upstream checksums.

The Shotcraft workbench can import `src/workbench.ts` to edit scenes, text and audio on a timeline. Native Remotion Studio is also available through the `studio` command above.
