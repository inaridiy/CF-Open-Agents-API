import { createRequire } from "node:module";

/**
 * Pins the generated project receives. They must agree with the workspace manifests;
 * `test/versions.test.mjs` compares them with packages/agent-api, examples/worker and
 * the root package.json.
 */
export const LIBRARY_NAME = "cf-open-agents-api";
export const CLI_NAME = "create-cf-open-agents-api";
export const GITHUB_REPOSITORY = "inaridiy/CF-Open-Agents-API";
export const VENDOR_DIRECTORY = ".cf-open-agents-api";

/** `ctx.exports`, which the Container SDK needs, is on by default from this compatibility date. */
export const CTX_EXPORTS_DATE = "2025-11-17";

export const PEER_VERSIONS = {
  effect: "3.22.2",
  openai: "7.15.0",
  ai: "7.0.97",
  zod: "4.6.2",
} as const;

export const PROVIDER_VERSIONS = {
  "@ai-sdk/openai": "4.0.65",
  "@ai-sdk/provider": "4.0.13",
  "@ai-sdk/anthropic": "4.0.53",
  "workers-ai-provider": "4.0.0",
} as const;

export const TOOLCHAIN_VERSIONS = {
  wrangler: "4.131.1",
  "@cloudflare/workers-types": "5.20260911.1",
  typescript: "5.9.3",
} as const;

const manifest = createRequire(import.meta.url)("../package.json") as { version: string };
/** The CLI's own version; the library, the vendored snapshot tag and the CLI share it. */
export const CLI_VERSION = manifest.version;
