# CF-Open-Agents-API — launch film

English, 1920×1080, 30 fps, 2175 frames (72.5 s), ten chapters. No voiceover. Restrained instrumental music and purposeful sound effects. Audience: developers integrating coding agents into applications. CTA: try, file an issue, contribute.

## What the film argues

The first cut (48 s, six scenes) showed the runtime logos, a build, an SDK snippet and a reload. It read well but stayed on the surface: it never said what the project _is_ or why its design matters. This cut keeps the visual language and the transition grammar and rebuilds the chapters around the library's actual thesis, taken from README.md and docs/architecture.md:

1. It is an implementation of the OpenAI Agents API (`agents=v1`); the official SDK is the client, unchanged.
2. Everything behind the URL runs in the viewer's Cloudflare account: Worker, SQLite Durable Objects, Containers, R2, a private model gateway.
3. The native runtimes (Codex, Claude Code, OpenCode) keep their own loops; the project supplies the API, the sandbox, the tools and the durability around them.
4. The deployment owns three things: the presets clients name, the model gateway, and who is calling (`defineAgentWorker`).
5. No container ever sees a provider key; model traffic leaves only through the gateway.
6. A real turn, end to end, with the files it wrote published as artifacts.
7. Durability is structural: one SQLite transaction per transition, an alarm-driven turn, a checkpoint to R2, resume from the last commit.
8. The environment is more than a shell: web search, MCP with Vault credentials, skills, programmatic tools, delegation, subagents, forks.

## Product evidence and visual direction

README.md, docs/architecture.md, docs/compatibility.md, examples/worker/src/index.ts and examples/demo/src/ui.tsx are the product sources. Demo tokens: #f6f6f4 background, #1a1a1a ink, #2563eb accent, #e1e1de borders, #6b6b67 muted, #16a34a success. White panels, 8–10px UI corners, system sans with monospace code. Film extends spacing and type size for 1080p; preserves this quiet utilitarian character. 96px horizontal safe area, 70–128px titles, 24–42px secondary text; footer metadata 22–25px. Large text is kept to three lines. No decorative particles or hand-held shake. Transitions are hard cuts followed by restrained entrances (fade + short rise); the account map is drawn once in chapter 02 and revisited unchanged in chapter 05 so the viewer keeps the same mental picture.

Runtime trademarks identify supported integrations, never project ownership or endorsement. End frame says Alpha / Independent implementation. Apache-2.0 applies to this project; third-party assets retain their terms in ASSETS.md.

## Storyboard

| Frames    | Time       | Chapter                 | Motion and content                                                                                                                                                                                                                                            | Source / audio                                       |
| --------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0–134     | 0–4.5s     | Hook                    | "The Agents API. Open source. On your Cloudflare account." Three-line reveal, blue last line, rule draws in. Eyebrow names the OpenAI Agents API `agents=v1`.                                                                                                 | Typography, soft opening                             |
| 135–389   | 4.5–13s    | 01 Keep the SDK         | Title demotes to a label (Shotcraft recipe); 13 lines of the official `openai` client: `new OpenAI`, `sessions.create`, `sessions.stream`. Three notes point at Worker, preset, sandbox.                                                                      | README / docs/http-api.md, line stagger, sweep       |
| 390–614   | 13–20.5s   | 02 Your account         | The account map: your application → a pale "Your Cloudflare account" box with AgentWorker, SessionDO, R2, Sandbox, Harness (three runtime marks), Model gateway → provider.                                                                                   | docs/architecture.md service table, staggered cards  |
| 615–794   | 20.5–26.5s | 03 Native runtimes      | Three runtime cards with `harness:` chips inside a "Harness containers" box. Copy: they run unmodified; this project supplies the API, sandbox, tools and durability.                                                                                         | Downloaded marks, settle                             |
| 795–1049  | 26.5–35s   | 04 The composition      | `defineAgentWorker` with `agents`, `models`, `authenticate` shortened from examples/worker; notes label presets, the private gateway, who is calling.                                                                                                         | examples/worker/src/index.ts, line stagger, sweep    |
| 1050–1229 | 35–41s     | 05 Credentials          | The same map, dimmed except Sandbox, Harness, gateway and provider. Badges: "no Internet access" on the harness, "network per policy" on the sandbox (its egress follows the environment's network policy), "holds the keys" on the gateway. Only one egress. | README security claims, no re-entrance               |
| 1230–1559 | 41–52s     | 06 A real turn          | Prompt, Build click, job page streaming shell/thinking cards (camera travel), outputs card, Download zip click, downloaded game start → play → win.                                                                                                           | Authorized Workers AI run; Edited for length; clicks |
| 1560–1799 | 52–60s     | 07 Durable by design    | Reload while building: same session before and after (header scrolls fully away). Four rules: one transaction, alarm, checkpoint, resume.                                                                                                                     | Real job capture, docs/architecture.md, click        |
| 1800–1964 | 60–65.5s   | 08 Environments & tools | Eight tiles: shell/files, web search, MCP, skills, programmatic tools, delegation, subagents, forks. Line: function calls become durable `required_actions`.                                                                                                  | docs/environments-and-tools.md, stagger, sweep       |
| 1965–2174 | 65.5–72.5s | Outro                   | Build on it. Chips, the `create-cf-open-agents-api@alpha init` command, GitHub URL, Try it. File an issue. Contribute. Held.                                                                                                                                  | Downloaded GitHub mark, settle                       |

Demo prompt: Build a polished, minimal tic-tac-toe game as one self-contained HTML file at /workspace/outputs/tic-tac-toe.html. Use an off-white background, blue X, dark O, system fonts, a clear turn indicator, win/draw detection, and a New game button. Two local players. No dependencies, no external resources. Use English for all UI and your short final response.

The provider and preset are identified accurately (Codex runtime, Workers AI `@cf/zai-org/glm-4.7-flash`, preset `coding`). Claude Code and OpenCode appear as supported options; the capture does not claim they built the game. No fabricated generated result. Both reload captures show `building…`, which supports the "same session before and after reload" claim; the durability rules on the right are documented behaviour from docs/architecture.md, not something this footage demonstrates on its own.

Code shown on screen is shortened from the repository's examples: the SDK chapter drops the import and blank lines; the composition chapter keeps the three sections of examples/worker/src/index.ts with fewer presets and models, and elides the full export list with the ones Wrangler binds. Model names are the README's examples; the presets and Workers AI model on screen are the current example Worker's, not the recorded run's `coding` preset and `glm-4.7-flash`.

## Shotcraft implementation references

- typing-code-block: gallery index verified; exact demo saved under reference. The shared `CodePanel` keeps the left-side line reveal, 8px travel, cubic easing and stable line boxes; the stagger is shortened to 8–9 frames because both code chapters show 13–14 lines inside 8.5 seconds. Token colours come from a small deterministic tokenizer, not hand-coloured spans.
- title-demote-to-label: exact demo saved under reference. Plain variant with 12f reveal, 20f hold, 20f continuous scale + position and content handover; applied once, in the SDK chapter. Settles at scale 0.61 (about 78px) rather than the reference's smaller label so the chapter retains the film's large typography.
- cursor-flyover: reviewed as inspiration for the focus travel in the real-turn chapter; PageCam copied from assets/lib/PageCam.tsx. The chapter uses original camera keys and cursor phases, not the four-corner Gallery choreography.
- The account map, its dimmed revisit, the tile grid and every other motion are original restrained layout animations, not claimed Gallery reproductions.

Intentional aesthetic adaptations: a quiet OSS developer film. No launch-event slam, flashing transitions or beat-driven cut. The ending holds the repository and invitation rather than a feature collage.

## Recorded-run evidence

Capture completed successfully using the authorized test app. The model generated a 5,593-byte HTML game, downloaded in its artifact ZIP. Win, reset and draw checks passed. Before/after reload captures both show the same session building, and the final output was then downloaded. Provenance: reference/capture/session.json, transcript.txt, game-check.json.

Music: House Vibez (Mixkit 745) from its start, at a restrained level with fade-in/out, applied in the timeline (see ASSETS.md). Chapter boundaries are chosen for reading time; no per-beat pumping.
