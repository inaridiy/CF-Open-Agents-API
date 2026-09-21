# Video validation

The PR attaches both 48-second final MP4s for inline playback. The exports are H.264, 1920×1080, 30 fps, with AAC stereo audio. BGM and no-BGM versions have identical encoded video streams; the latter retains sound effects.

## Real-provider evidence

The authorized demo used the Codex runtime with Workers AI `@cf/zai-org/glm-4.7-flash`, preset `coding`. It produced an actual 5,593-byte HTML game and artifact ZIP. Win, reset and draw checks passed. Before/after reload screenshots show the same active job. This is edited demonstration footage, not a latency benchmark. `reference/capture/` preserves the session metadata, transcript, game checks and downloaded ZIP.

## Rendering and quality

- Video typecheck and `pnpm exec oxlint --type-aware video` passed.
- Root `pnpm typecheck`, `pnpm check:docs`, `pnpm check:harness` and frozen lockfile validation passed.
- Root `pnpm lint` formatting passed, but its type-aware lint reports one pre-existing unnecessary assertion at `tests/containers/worker.ts:213`. That file is unchanged.
- Both MP4s contain 1,440 frames. Encoded video SHA-256: `7ea3ebfab29ff207fc6368111df51052a8744b0ab66513f3f07edc8a6f60c804`.
- Measured peaks: −12.60 dBFS with music; −14.69 dBFS without. No clipping. Sampled clicks are within 1.35 frames of intended actions.
- Workbench reconstruction matches the original at frames 95, 247, 690, 936, 1165 and 1340 with zero differing pixels.
- After source lint cleanup, frames 450, 690 and 936 were rendered again and inspected against frames extracted from the final MP4. Browser navigation, evaluation, screenshot capture and error propagation were exercised against the existing local game; no extra model job was submitted.
- Independent review: `reference/independent-review.md`. No confirmed blocking defects; small secondary text and a minor screenshot crop are optional improvements. Subjective listening and uninterrupted playback were not verified by that reviewer. Its documentation suggestions for color range, title scale and music checksums have been addressed.

No API, persistence, runtime or published-package behavior changes. The server integration/container suites were not rerun for this video-only addition.
