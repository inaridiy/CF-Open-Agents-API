/**
 * `@cloudflare/workers-types` declares `Buffer` as `any`, shadowing the typed global from
 * `@types/node`. This alias restores the members the native runtimes rely on.
 *
 * The supervisor's own `tsconfig.build.json` loads node types alone and does not need
 * this, but the root `tsconfig.json` — which `pnpm typecheck` and the type-aware lint
 * both read — loads both packages for the whole workspace. Importing `node:buffer`
 * does not escape it either: that module re-exports the same shadowed global, so every
 * call site reports `no-unsafe-*` without this alias.
 */
type BufferLike = Uint8Array<ArrayBuffer> & { toString(encoding?: string): string };
export const Buffer = (globalThis as unknown as { Buffer: unknown }).Buffer as {
  from(data: Uint8Array | ArrayBuffer | ArrayLike<number> | string, encoding?: string): BufferLike;
  concat(list: readonly Uint8Array[]): BufferLike;
  byteLength(data: Uint8Array): number;
};
