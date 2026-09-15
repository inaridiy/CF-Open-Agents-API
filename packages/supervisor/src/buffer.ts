/**
 * `@cloudflare/workers-types` declares `Buffer` as `any`, shadowing the typed global from
 * `@types/node`. This alias restores the members the native runtimes rely on.
 */
type BufferLike = Uint8Array<ArrayBuffer> & { toString(encoding?: string): string };
export const Buffer = (globalThis as unknown as { Buffer: unknown }).Buffer as {
  from(data: Uint8Array | ArrayBuffer | ArrayLike<number> | string, encoding?: string): BufferLike;
  concat(list: readonly Uint8Array[]): BufferLike;
  byteLength(data: Uint8Array): number;
};
