# Independent final review — CF-Open-Agents-API

Reviewed 2026-09-21. Read-only review of the supplied production, with this report as the sole written artifact. Baseline: user-approved six-scene, English, quiet landscape OSS film; `DESIGN.md`, `ASSETS.md`, current README/compatibility profile, Shotcraft final-review and aesthetic rules. No requirement to copy reference-demo colors or add launch-event effects.

**Disposition:** No confirmed release-blocking defect in the inspected frames, factual claims, or media. Small-screen secondary text and two documentation details merit improvement. Subjective listening and uninterrupted real-time motion viewing remain unverified; this is not an unconditional audiovisual sign-off.

## Product, narrative and provenance

- P1 ✓ f95: self-hosted coding agents on the viewer's Cloudflare account is clear and agrees with README lines 8–17.
- P2/P4 ✓ Six priorities map directly to frames 0–119, 120–299, 300–719, 720–959, 960–1199 and 1200–1439. The approved quiet direction is visible in the film. The supplied design includes a storyboard and execution decisions, but no separately preserved approval transcript/decision-table document; approval is taken from the task's explicit baseline.
- P3 ✓ f247/f936/f1165/f1340: runtime choices, official OpenAI client compatibility, SQLite Durable Objects, R2 checkpoints, Worker-held keys and Apache-2.0 are supported by README and docs/compatibility.md. The SDK snippet configures a client; it does not falsely claim to be a complete job submission. The independent/alpha qualification appears, although too small for easy mobile reading.
- F1 ✓ All six required subjects appear. f340/f397 shows the real prompt and Build control; f450/f500 shows execution; f558 shows Download zip; f600/f690 shows the resulting game. f978/f1052/f1165 covers reconnection.
- F2 ✓ Each scene advances the story. Returning to the same job in the durability scene demonstrates a separate property, rather than repeating the creation demo.
- F3 ✓ Download affordance and playable result are identifiable. The detailed job trace and durable-session identifier are primarily evidence texture at small playback sizes.
- D1/D2/D5 ✓ Inspected frames show a user-authorized synthetic game prompt, local demo state and a session identifier, not customer records or credentials. No exposed bearer key or provider secret found. Source metadata contains loopback URLs; the composited browser title replaces the address bar.
- D3/D4 ✓ Real page textures and selected elements have matching layout/provenance records. `home.png` is 3840×2160; job action 3840×4266; generated game 2400×1440. The same session URL appears in both reconnect layout files. Both visible captures show `building…`. This supports browser reload continuity; it does not independently demonstrate container loss recovery, which the film does not claim.
- D6 ✓ `out/capture/session.json` identifies Codex with Workers AI `@cf/zai-org/glm-4.7-flash`, preset `coding`. Transcript, output card and ZIP agree on a 5,593-byte `tic-tac-toe.html`. ZIP contents were independently inspected. `game-check.json` records win/reset/draw success; this review did not rerun the game.
- D7 ✓ All ten assets listed in `assets.json` match their local SHA-256 checksums. Runtime marks are downloaded assets. ASSETS distinguishes third-party terms from the project license. Music source/terms are recorded in ASSETS but the derived music WAV/source track is absent from the checksum manifest; see O4.

## Visual direction, reference fidelity and timing

- V1–V4 ✓ f95/f247/f936/f1340: off-white, dark ink, restrained blue, white panels and consistent sans/mono hierarchy match DESIGN. No unrelated neon treatment, particles, generic template recolor or conspicuous glow.
- S1/S2 ✓ Gallery records, saved exact TSX and extracted reference-MP4 images agree on the two adapted recipes. Compared reference typing at 0.6/2.8 seconds and plain title demotion at 0.7/1.7 seconds. Cursor-flyover is correctly documented as inspiration, not claimed reproduction.
- S3 ✓ SDK line reveal retains approximately 19-frame staggering, 41-frame cubic fades, 8px travel, token colors from entry and stable line boxes. Full code is settled by f898, leaving approximately 2 seconds before the scene cut. The Gallery summary's “4f” text conflicts with the actual source's `0.14 × 138 ≈ 19f`; production follows the exact source and the detailed card.
- S4 △ Title demotion preserves 12-frame reveal, 20-frame hold, 20-frame continuous cubic scale/position and overlapping content handover. Final scale is 0.61, versus the recipe's 0.3 and warning above 0.45. f936 shows no collision and retains readability, so this is an adaptation to document, not a demonstrated visual defect. Blur is also omitted in the restrained adaptation.
- S5/S6 ✓ Product tokens/crops are coherent; neither chosen recipe is presented as an unsupported custom Gallery variant.
- B1/B2/B4 ✓ Timeline matches the approved scene order and durations exactly. Main transitions are hard cuts followed by restrained entrances, not added flash effects. Source and keyframes agree on the prompt/build/download/game sequence.
- B3/R1 ✓ Hook settles by f76, leaving 44 frames. Runtime cards settle by f194, leaving over 3 seconds. Outro finishes entry by f1268, leaving over 5 seconds. No wordmark is immediately cut after settling.
- R2/R3 △ Easing is nonlinear and reading holds are generous. The prompt is already filled, so it is not falsely presented as ultra-fast typing. Game states are edited still captures. Intro headline motion lasts under 3 seconds, but the approved typography hook has a 4-second total duration and a stable reading hold; the object-orbit rule is not directly applicable.
- R4/Q3/Q4 ✓ No random handheld movement, per-beat camera pumping, mass glints or unbounded glow found in scene source or sampled frames.
- Q1/Q2 ✓ Native screenshots, high-resolution sources and PageCam are used. Main text and code are sharp at 1080p. f558's ZIP button remains legible at 480px width.
- Q5/Q6 ✓ Opening has one typographic subject. Information panels are frontal, avoiding destructive perspective compression.
- Q7/Q8 — Object-pile/orbit treatment is not used. A quiet GitHub hold instead of a peak-energy collage is explicitly justified in DESIGN and consistent with approval.
- Q9/Q10 ✓ Runtime cards resolve into a real composition. Job/demo screenshots retain real page structure rather than fabricated placeholder documents. f1165 slightly clips the Agent Builder heading while the screenshot scrolls beneath the browser bar; O2.
- Q11 △ Main headlines, result and URL remain readable in a 480px-wide simulation. Supplementary text does not consistently meet the generic ≥32px auxiliary guidance: footer 22–25px; durability body 27px; many captured trace labels are smaller. At 480px, edit/compatibility qualifiers and session IDs are difficult to read. DESIGN explicitly selects small footer metadata, so this is reported as an accepted-direction tradeoff requiring consideration, rather than silently marked as full rule compliance. See O1.
- C1/C2 ✓ Every scene has a clear headline and concrete subject. The short OSS invitation is appropriate to the approved ending. No unsupported feature tagline found.
- C3 — No perspective-space annotation is used.
- P1/P2/P4 ✓ Final extracted MP4 keyframes, real-run records, reference source and reference media were inspected. Motion techniques have distinct roles. P3 (historical response-to-feedback process) is outside this read-only review.
- Q12 ✓ No `Math.random()` or `Date.now()` found in scene/timeline source. Frame-driven animation is deterministic by inspection; a second full render was not needed for this claim.

## Audio and technical delivery

- T1 ✓ Independently probed both final files: H.264, 1920×1080, 30/1 fps, exactly 1,440 video frames, 48.000s video; AAC stereo 48kHz, 48.064s audio/container. The extra 64ms is audio padding, not extra video frames. Each file is 5,305,016 bytes at review time.
- T2 △ Decoder reports `yuvj420p` (full-range 4:2:0), whereas video/README says `yuv420p`. This is documentation/range specificity, not a demonstrated playback failure. See O3.
- A1/S1/S4 △ Declared sources are instrumental music, physical switch tap, sweep and bass hit. The line reveal is not literal character typing, so absence of continuous keyboard sound is appropriate. The actual aesthetic/timbre/mix has not been subjectively auditioned by this reviewer.
- A2/S2/S3 ✓ Six SFX are explicitly pinned in `timeline.ts`. Click peaks were measured from decoded final no-BGM audio at global frames **394.346875, 553.346875, 1035.3525**, for intended clicks **393, 552, 1034**. Source tap peak is at 0.0625 frames; residual output delay is **1.284375, 1.284375, 1.290 frames**. Thus sampled clicks are within 3 frames, with a consistent ~2,055-sample codec-pipeline delay.
- A3/R4 — DESIGN explicitly chooses reading-time cuts with quiet background music, not a beat-driven edit. No beat-grid conformity is claimed or required for this approved direction.
- A4 — Quiet resolution instead of riser→impact→sparkle is an explicit approved adaptation.
- A5 ✓ Every SFX has an explicit duration (15–45 frames); no >5-second effect can leak into another scene through an unbounded sequence.
- A6 ✓ Decoded final PCM: music version peak **−12.60 dBFS**, RMS **−26.09 dBFS**; no-BGM peak **−14.69 dBFS**, RMS **−46.82 dBFS**. No clipping. These measurements do not establish subjective audibility of every SFX underneath music.
- A7 ✓ Physical light-switch source is documented; no synthetic notification-tone source is listed.
- A8 ✓ Both exports exist. Their demuxed H.264 elementary streams have identical SHA-256 **7ea3ebfab29ff207fc6368111df51052a8744b0ab66513f3f07edc8a6f60c804**, proving identical encoded video. Audio PCM hashes differ; first 3 seconds of no-BGM are digital silence, while music version is audible signal. Source shares the same SFX table. Lossy AAC means final waveforms need not subtract perfectly.
- A9/S5 △ The measured systematic ~1.29-frame delay has not been compensated in source. It is below the 3-frame sync tolerance for the sampled clicks. Record this measured pipeline value if precise future recuts are expected; do not claim zero offset.

## Prioritized outcome

### Must fix

None confirmed within inspected material. Subjective audiovisual playback remains a verification limit rather than an invented defect.

### Optional improvements

1. **O1 — Secondary readability, f340/f558/f936/f1165/f1340.** Enlarge “Recorded demo · Edited for length” and “Use the official OpenAI SDK”/alpha qualification to at least 32px or move the essential qualification into the headline. The large “Official SDK.” is supported by context, but at mobile size the qualifier explaining whose SDK is much less readable. Enlarge durability annotation bodies if viewers are expected to read them. Preserve the already-legible GitHub URL. Small decorative trace text need not all be enlarged.
2. **O2 — Durable pane crop, f1165.** The screenshot's Agent Builder heading is partly cut by the browser bar after its −60px scroll. Keep the header fully visible or scroll it fully away, avoiding the partial-letter edge. Core session state is still visible.
3. **O3 — Documentation precision.** Explicitly record the 0.61 title-demotion scale adaptation and full-range `yuvj420p` output. Do not describe this as exact parameter reproduction or limited-range output.
4. **O4 — Music reproducibility.** Add original/derived music checksums and exact fade/attenuation recipe to the asset manifest or provenance record; current URL and license attribution are present, but not the same checksum-level provenance as the ten other assets.
5. **O5 — Audio offset bookkeeping.** Preserve the measured 4.0.526/H.264/AAC/48kHz/MP4 output residual (~1.29 frames) in QA notes. Compensation is optional for this sparse, already-within-tolerance edit, but useful if stronger synchronized impacts are added later.

### Unverified or scope-limited

- No uninterrupted real-time viewing or subjective listening in this review; final keyframes, reference frames, source timing and objective PCM measurements were examined instead. Minute transition seams or perceived SFX masking can therefore remain.
- Did not rerun live providers, the generated game or repository suites; the review uses the authorized-run records and independent ZIP inspection.
- Asset hashes/local provenance were checked; remote source license terms and trademark permissions were not independently re-researched. This is not a legal clearance report.
- Parent is separately checking workbench parity. That claim is not needed for the independent encoded-video parity result above.
