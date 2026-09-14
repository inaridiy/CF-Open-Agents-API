/** Enforce the session's search mode at model egress. Codex 0.154.0 can promote
 * cached search to live under full-access execution, even with explicit config.
 * This changes only tool configuration; the native runtime still owns the loop.
 */
export function constrainCodexSearch(
  body: Record<string, unknown>,
  mode: "disabled" | "cached" | "live",
): Record<string, unknown> {
  if (!Array.isArray(body.tools)) return body;
  return {
    ...body,
    tools: body.tools.flatMap((tool: unknown) => {
      if (!tool || typeof tool !== "object" || !("type" in tool) || tool.type !== "web_search")
        return [tool];
      return mode === "disabled" ? [] : [{ ...tool, external_web_access: mode === "live" }];
    }),
  };
}
