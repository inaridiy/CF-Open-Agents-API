import { crc32, inflateRawSync } from "node:zlib";

import { z } from "zod";

import { SkillInvalid, SkillTooLarge } from "./errors.js";

export interface SkillZipEntry {
  bytes: Uint8Array;
  executable: boolean;
}
const invalid = () => new SkillInvalid({ reason: "Invalid or unsupported skill ZIP archive" });
const inflated = z.object({
  buffer: z.instanceof(Uint8Array),
  engine: z.object({ bytesWritten: z.number() }),
});
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** Little-endian readers over the archive bytes. */
interface Reader {
  readonly data: Uint8Array;
  readonly u16: (at: number) => number;
  readonly u32: (at: number) => number;
}
const reader = (data: Uint8Array): Reader => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    data,
    u16: (at) => view.getUint16(at, true),
    u32: (at) => view.getUint32(at, true),
  };
};
/** One central directory record, as far as the reader needs it. */
interface CentralEntry {
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressed: number;
  readonly expanded: number;
  /** Bytes of the file name field. */
  readonly filename: Uint8Array;
  readonly name: string;
  readonly directory: boolean;
  readonly path: string;
  readonly mode: number;
  readonly local: number;
  /** Offset of the next central record. */
  readonly next: number;
}

/** The end-of-central-directory record: `{ end, count, central }` or a rejection. */
function endOfCentralDirectory({ data, u16, u32 }: Reader) {
  let end = data.length - 22;
  while (
    end >= Math.max(0, data.length - 65_557) &&
    (u32(end) !== END_OF_CENTRAL_DIRECTORY || end + 22 + u16(end + 20) !== data.length)
  )
    end--;
  if (
    end < 0 ||
    u32(end) !== END_OF_CENTRAL_DIRECTORY ||
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== u16(end + 10)
  )
    throw invalid();
  const count = u16(end + 10);
  const central = u32(end + 16);
  if (!count || count > 1000 || central + u32(end + 12) !== end) throw invalid();
  return { end, count, central };
}
/** A path is relative, printable and free of traversal; a directory name drops its slash. */
function entryPath(name: string): { path: string; directory: boolean } {
  const directory = name.endsWith("/");
  const path = directory ? name.slice(0, -1) : name;
  if (
    !path ||
    /[\\:]/.test(path) ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw invalid();
  return { path, directory };
}
/** Read and validate the central record at `at`; it must end before `end`. */
function centralEntry({ data, u16, u32 }: Reader, at: number, end: number): CentralEntry {
  if (at + 46 > end || u32(at) !== CENTRAL_HEADER) throw invalid();
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
  const { path, directory } = entryPath(name);
  return {
    flags,
    method,
    crc,
    compressed,
    expanded,
    filename,
    name,
    directory,
    path,
    mode,
    local,
    next: at + 46 + length + extra + comment,
  };
}
/** The unix mode, when present, must agree with the directory flag. */
function assertKind(entry: CentralEntry, names: Set<string>): void {
  const kind = entry.mode & 0o170000;
  if (names.has(entry.path) || (kind !== 0 && kind !== (entry.directory ? 0o040000 : 0o100000)))
    throw invalid();
}
/**
 * The local header must agree with the central record; returns the data range
 * `[start, finish)` of the entry's compressed bytes.
 */
function localRange({ data, u16, u32 }: Reader, entry: CentralEntry, central: number) {
  const { local, flags, method, filename } = entry;
  const length = filename.length;
  if (
    local + 30 > central ||
    u32(local) !== LOCAL_HEADER ||
    u16(local + 6) !== flags ||
    u16(local + 8) !== method ||
    u16(local + 26) !== length
  )
    throw invalid();
  if (!filename.every((byte, offset) => byte === data[local + 30 + offset])) throw invalid();
  if (
    !(flags & 8) &&
    (u32(local + 14) !== entry.crc ||
      u32(local + 18) !== entry.compressed ||
      u32(local + 22) !== entry.expanded)
  )
    throw invalid();
  const start = local + 30 + length + u16(local + 28),
    finish = start + entry.compressed;
  if (start > central || finish > central || finish < start) throw invalid();
  return { start, finish };
}
/** Stored bytes as is; deflated bytes through zlib with the declared size as the ceiling. */
function entryBytes(source: Uint8Array, entry: CentralEntry): Uint8Array {
  if (entry.method !== 8) return source;
  const result: unknown = inflateRawSync(source, {
    maxOutputLength: Math.max(1, entry.expanded),
    info: true,
  });
  const decoded = inflated.parse(result);
  if (decoded.engine.bytesWritten !== source.length) throw invalid();
  return decoded.buffer;
}
/** Entry data ranges may not overlap. */
function assertDisjoint(ranges: [number, number][]): void {
  ranges.sort(([a], [b]) => a - b);
  for (let index = 1; index < ranges.length; index++)
    if ((ranges[index]?.[0] ?? 0) < (ranges[index - 1]?.[1] ?? 0)) throw invalid();
}
/** No file may also be a directory prefix of another entry. */
function assertNoFileDirectories(names: Set<string>, entries: Map<string, SkillZipEntry>): void {
  for (const name of names) {
    const parts = name.split("/");
    for (let length = 1; length < parts.length; length++)
      if (entries.has(parts.slice(0, length).join("/"))) throw invalid();
  }
}

/** ZIP32 metadata only. Native zlib enforces an allocation limit and checksums. */
export function readSkillZip(data: Uint8Array, limit: number): Map<string, SkillZipEntry> {
  try {
    const archive = reader(data);
    const { end, count, central } = endOfCentralDirectory(archive);
    const entries = new Map<string, SkillZipEntry>();
    const names = new Set<string>();
    const ranges: [number, number][] = [];
    let at = central;
    let size = 0;
    for (let index = 0; index < count; index++) {
      const entry = centralEntry(archive, at, end);
      assertKind(entry, names);
      names.add(entry.path);
      size += entry.expanded;
      if (size > limit) throw new SkillTooLarge({ limit: "expanded" });
      const { start, finish } = localRange(archive, entry, central);
      ranges.push([entry.local, finish]);
      const bytes = entryBytes(data.subarray(start, finish), entry);
      if (
        bytes.length !== entry.expanded ||
        crc32(bytes) !== entry.crc ||
        (entry.directory && entry.expanded)
      )
        throw invalid();
      if (!entry.directory) entries.set(entry.name, { bytes, executable: !!(entry.mode & 0o111) });
      at = entry.next;
    }
    if (at !== end) throw invalid();
    assertDisjoint(ranges);
    assertNoFileDirectories(names, entries);
    return entries;
  } catch (error) {
    if (error instanceof SkillInvalid || error instanceof SkillTooLarge) throw error;
    throw invalid();
  }
}
