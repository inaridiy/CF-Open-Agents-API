import { randomUUID } from "node:crypto";

/** Two UUIDs without dashes: 64 hex characters, well above the 32 `bearerTenant` requires. */
export function randomToken(): string {
  return `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
}

export const MINIMUM_TOKEN_LENGTH = 32;
