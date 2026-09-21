# Video validation

The PR attaches both final MP4s for inline playback: 72.5 seconds, H.264, 1920×1080, 30 fps, with AAC stereo audio. The music and no-music versions have identical encoded video streams; the latter retains the sound effects.

## Real-provider evidence

Unchanged from the first cut. The authorized demo used the Codex runtime with Workers AI `@cf/zai-org/glm-4.7-flash`, preset `coding`. It produced an actual 5,593-byte HTML game and artifact ZIP. Win, reset and draw checks passed. Before/after reload screenshots show the same active job. This is edited demonstration footage, not a latency benchmark. `reference/capture/` preserves the session metadata, transcript, game checks and downloaded ZIP. No new provider job was submitted for this cut; every chapter renders from the included textures.

## Rendering and quality

- Video typecheck and `pnpm exec oxlint --type-aware video` pass. Root `pnpm typecheck`, `pnpm check:docs` and `pnpm check:harness` pass (the root typecheck prints three pre-existing Effect suggestions outside `video/`). Touched files are formatted with `pnpm exec oxfmt`.
- Both MP4s were probed from their MP4 boxes (no FFmpeg on this machine): 2,175 video samples at timescale 90,000 (72.500 s), AAC at 48 kHz with 3,401 samples (72.555 s; the extra 55 ms is codec padding). The two files are 10,425,705 bytes each.
- The concatenated video sample bytes hash identically in both exports: SHA-256 `b2f15d386bd6e744c01e1b3e74d1daffcfeac4216213a4122d55ccdff93a2a75` (7,468,198 bytes). The audio sample streams differ.
- Music presence was checked without decoding: the audio stream of the music export compresses to 0.94 of its size with zlib, the no-music export to 0.07 (its first three seconds, before the first sound effect, compress to 0.006, that is, digital silence). This shows the music is present and the no-music export is quiet between effects; it does not measure loudness.
- Keyframes were rendered with `scripts/stills.mjs` at 95, 200, 365, 540, 745, 1015, 1160, 1280, 1380, 1430, 1530, 1650, 1730, 1940 and 2085 and inspected at 1080p. Frames 1015, 1160, 1730 and 1940 were rendered again after the copy review's fixes, and the exports were rendered after them. Every headline, code line, note and card is inside the panels; no overflow or collision remains after the second pass (an overlong `nativeModel` line and a colliding annotation in the composition chapter, the credentials arrow label and the artifact path were fixed).
- The durability chapter now scrolls the page header fully out of the browser panel (the first cut's partial-crop note).
- Sound-effect cues are pinned in `src/timeline.ts` relative to their chapters; clicks fall on the Build, Download zip and reload actions. The ~1.3-frame encoder delay measured on the first cut was not re-measured.

## Limits

- No uninterrupted real-time viewing or subjective listening was done in this environment; keyframes, source timing and stream-level measurements stand in for it.
- The final MP4 frames were not decoded here; the stills come from the same bundle and browser the renderer used.
- The runtime, provider and durability copy was checked against the repository's README and docs (see `reference/copy-review.md`), not against a live deployment.

No API, persistence, runtime or published-package behavior changes. The server integration/container suites were not rerun for this video-only change.
