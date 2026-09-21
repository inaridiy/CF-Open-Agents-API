# Asset provenance

Runtime marks were downloaded from the Internet for this film. They identify compatibility, not endorsement. None was redrawn or reshaped. See `assets.json` for exact download URLs and SHA-256 checksums.

| In the film                      | Source                                                                                     | Terms / credit                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Codex icon                       | [Lobe Icons](https://github.com/lobehub/lobe-icons)                                        | MIT artwork distribution; OpenAI trademark. LICENSE copy in reference.             |
| Claude Code icon                 | [Official Claude Code docs](https://code.claude.com/docs/en/overview) favicon              | Anthropic trademark. Downloaded original icon.                                     |
| OpenCode icon                    | [Official OpenCode brand assets](https://opencode.ai/brand), anomalyco/opencode repository | Anomaly trademark. Original light square variant.                                  |
| Cloudflare and GitHub marks      | Lobe Icons                                                                                 | MIT artwork distribution; respective owners retain trademarks.                     |
| Inter and JetBrains Mono         | Google Fonts upstream repositories                                                         | SIL Open Font License 1.1; copies in reference.                                    |
| House Vibez, Lily J              | [Mixkit track 745](https://assets.mixkit.co/music/745/745.mp3)                             | Mixkit Stock Music Free License. First 48s, attenuated and faded.                  |
| Fast small sweep transition      | [Mixkit 166](https://assets.mixkit.co/active_storage/sfx/166/166-preview.mp3)              | Mixkit Sound Effects Free License.                                                 |
| On or off light switch tap       | [Mixkit 2585](https://assets.mixkit.co/active_storage/sfx/2585/2585-preview.mp3)           | Mixkit Sound Effects Free License.                                                 |
| Short bass hit                   | [Mixkit 2299](https://assets.mixkit.co/active_storage/sfx/2299/2299-preview.mp3)           | Mixkit Sound Effects Free License.                                                 |
| PageCam and motion references    | [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft)                       | Copied reusable PageCam; other components adapt documented motion recipes.         |
| Agent Builder and generated game | Actual user-authorized run on Workers AI                                                   | Captured from open-agents-api-test. English prompt, actual generated HTML and ZIP. |

Third-party media keeps its own terms and is not relicensed under this repository's Apache-2.0. [Mixkit licenses](https://mixkit.co/license/) govern stock music and sound effects. Rendered videos may be shared; do not redistribute stock audio as a standalone asset library.

The only capture localization was the Japanese help sentence on the input page, translated in the capture browser. The actual submitted prompt and the runtime's responses are English. The generated HTML was not changed; only browser viewport and camera framing were adjusted. The UI footage uses selected 2× screenshots from one real run with frame-driven camera and cursor movement. It is visibly marked "Recorded demo · Edited for length"; it is not a speed benchmark.

The demo ran the Codex runtime with Workers AI `@cf/zai-org/glm-4.7-flash`, preset `coding`. Claude Code and OpenCode appear as supported runtime options; this capture does not assert they were used to build the demonstrated game.

## Music edit provenance

- Original: House Vibez by Lily J, Mixkit track 745 (URL above). Source MP3 SHA-256: `eff4aceea32ed5f9651673cedfd86f5b2de143dd865f56d7b5c79d43dd9e81f5`.
- Delivered `public/audio/music.wav`: 48,000 Hz, 2 channels, 16-bit PCM, 48 seconds. SHA-256: `828cf36c7744602179c18c0539c98edefc817145adfeffefe5cdd899a104763e`.
- Edit: first 48 seconds decoded to stereo PCM; gain 0.32, linear 1.2-second fade-in and 3-second fade-out, converted to 16-bit WAV. The Remotion timeline applies an additional gain of 0.65.
