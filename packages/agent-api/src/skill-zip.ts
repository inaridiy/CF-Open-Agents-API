import { crc32, inflateRawSync, type ZlibOptions } from "node:zlib";
import { z } from "zod";
import { ApiError } from "./protocol.js";

export interface SkillZipEntry {
  bytes: Uint8Array;
  executable: boolean;
}
const invalid = () =>
  new ApiError(400, "invalid_skill", "Invalid or unsupported skill ZIP archive");
const inflated = z.object({
  buffer: z.instanceof(Uint8Array),
  engine: z.object({ bytesWritten: z.number() }),
});

/** ZIP32 metadata only. Native zlib enforces an allocation limit and checksums. */
export function readSkillZip(data: Uint8Array, limit: number): Map<string, SkillZipEntry> {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u16 = (at: number) => view.getUint16(at, true);
    const u32 = (at: number) => view.getUint32(at, true);
    let end = data.length - 22;
    while (
      end >= Math.max(0, data.length - 65_557) &&
      (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== data.length)
    )
      end--;
    if (
      end < 0 ||
      u32(end) !== 0x06054b50 ||
      u16(end + 4) ||
      u16(end + 6) ||
      u16(end + 8) !== u16(end + 10)
    )
      throw invalid();
    const count = u16(end + 10);
    const central = u32(end + 16);
    if (!count || count > 1000 || central + u32(end + 12) !== end) throw invalid();
    const entries = new Map<string, SkillZipEntry>();
    const names = new Set<string>();
    const ranges: [number, number][] = [];
    let at = central;
    let size = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > end || u32(at) !== 0x02014b50) throw invalid();
      const flags = u16(at + 8),
        method = u16(at + 10),
        crc = u32(at + 16);
      const compressed = u32(at + 20),
        expanded = u32(at + 24);
      const length = u16(at + 28),
        extra = u16(at + 30),
        comment = u16(at + 32);
      const mode = u32(at + 38) >>> 16,
        local = u32(at + 42);
      if (
        flags & ~0x080e ||
        ![0, 8].includes(method) ||
        u16(at + 34) ||
        at + 46 + length + extra + comment > end ||
        !length ||
        length > 1024
      )
        throw invalid();
      const filename = data.subarray(at + 46, at + 46 + length);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(filename);
      const directory = name.endsWith("/");
      const path = directory ? name.slice(0, -1) : name;
      if (
        !path ||
        /[\\:]/.test(path) ||
        Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
        path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw invalid();
      const kind = mode & 0o170000;
      if (names.has(path) || (kind !== 0 && kind !== (directory ? 0o040000 : 0o100000)))
        throw invalid();
      names.add(path);
      size += expanded;
      if (size > limit) throw new ApiError(413, "skill_too_large", "Expanded skill exceeds 32 MiB");
      if (
        local + 30 > central ||
        u32(local) !== 0x04034b50 ||
        u16(local + 6) !== flags ||
        u16(local + 8) !== method ||
        u16(local + 26) !== length
      )
        throw invalid();
      if (!filename.every((byte, offset) => byte === data[local + 30 + offset])) throw invalid();
      if (
        !(flags & 8) &&
        (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== expanded)
      )
        throw invalid();
      const start = local + 30 + length + u16(local + 28),
        finish = start + compressed;
      if (start > central || finish > central || finish < start) throw invalid();
      ranges.push([local, finish]);
      const source = data.subarray(start, finish);
      let bytes: Uint8Array = source;
      if (method === 8) {
        const result: unknown = inflateRawSync(source, {
          maxOutputLength: Math.max(1, expanded),
          info: true,
        } as ZlibOptions & { info: true });
        const decoded = inflated.parse(result);
        if (decoded.engine.bytesWritten !== source.length) throw invalid();
        bytes = decoded.buffer;
      }
      if (bytes.length !== expanded || crc32(bytes) !== crc || (directory && expanded))
        throw invalid();
      if (!directory) entries.set(name, { bytes, executable: !!(mode & 0o111) });
      at += 46 + length + extra + comment;
    }
    if (at !== end) throw invalid();
    ranges.sort(([a], [b]) => a - b);
    for (let index = 1; index < ranges.length; index++)
      if ((ranges[index]?.[0] ?? 0) < (ranges[index - 1]?.[1] ?? 0)) throw invalid();
    for (const name of names) {
      const parts = name.split("/");
      for (let length = 1; length < parts.length; length++)
        if (entries.has(parts.slice(0, length).join("/"))) throw invalid();
    }
    return entries;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid();
  }
}
