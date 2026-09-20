/**
 * Phrases by which a runtime reports that it never reached the other side, as
 * opposed to an answer it did not like. The union of what the native runtimes and
 * the Worker's own fetches emit:
 *
 * - reqwest and tokio, wrapped in Codex's `other` errors: `error sending request`,
 *   the socket errors it wraps (`connection reset|refused|aborted`, `connection
 *   closed before message completed`), `failed to connect`, `stream disconnected`,
 *   `dns error`, `failed to lookup address`, `network (is) unreachable`, `timed
 *   out connecting`, `connection timed out`;
 * - Node socket error codes as they appear in Claude Code and OpenCode messages
 *   and in the supervisor's diagnostics: `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`,
 *   `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`;
 * - undici's `fetch failed`, the message of a Node `fetch` whose cause is one of those.
 *
 * A message that also names an HTTP status is an answer from the upstream, so a
 * caller maps the status first and consults this list only when the status maps
 * to nothing.
 */
export const CONNECTION_FAILURE =
  /error sending request|connection (?:reset|refused|aborted|closed before)|failed to connect|stream disconnected|dns error|failed to lookup address|network (?:is )?unreachable|timed out connecting|connection timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|fetch failed/i;
