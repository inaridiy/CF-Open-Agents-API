import { RecordTooLarge } from "../errors.js";

// Leave space for SQLite's row metadata below the platform's 2 MB row limit.
const MAX_ROW_BYTES = 1_900_000;
/** Serialize one row and enforce the byte budget, keys included. */
export function encodeRow(value: unknown, ...keys: string[]): string {
  const serialized = JSON.stringify(value);
  const encoder = new TextEncoder();
  const size =
    encoder.encode(serialized).byteLength +
    keys.reduce((total, key) => total + encoder.encode(key).byteLength, 0);
  if (size > MAX_ROW_BYTES) throw new RecordTooLarge({ bytes: size });
  return serialized;
}
