import { Data } from "effect";

/**
 * The HTTP projection of a failure: status, code and message. Nothing in the package
 * constructs one except `toApiError` (errors.ts) and `remoteApiError`, which recovers
 * one from the wire name a definite failure carries across an un-enveloped Workers RPC
 * hop. It stays exported as the shape a caller can read.
 */
export type Status = 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503;
const STATUSES: readonly Status[] = [400, 401, 404, 409, 413, 422, 429, 500, 503];
export const isStatus = (value: unknown): value is Status => STATUSES.includes(value as Status);

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: Status;
  readonly code: string;
  readonly message: string;
}> {
  constructor(status: Status, code: string, message: string) {
    super({ status, code, message });
    // Error name/message survive Workers RPC; custom properties/prototypes do not.
    this.name = `AgentApiError:${status}:${code}`;
  }
}
export function remoteApiError(error: Error): ApiError | undefined {
  if (error instanceof ApiError) return error;
  const match = /^AgentApiError:(400|401|404|409|413|422|429|500|503):([a-z_]+)$/.exec(error.name);
  if (!match?.[1] || !match[2]) return undefined;
  const status = Number(match[1]);
  return isStatus(status) ? new ApiError(status, match[2], error.message) : undefined;
}
