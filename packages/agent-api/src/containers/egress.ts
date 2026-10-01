import { WorkerEntrypoint } from "cloudflare:workers";

import { ContainerMisconfigured } from "../errors.js";
import type { ContainerBindings } from "./host.js";

/** The Worker-side hosts a harness container reaches; each is answered by its own HarnessDO. */
export const HARNESS_EGRESS_HOSTS = [
  "model.internal",
  "media.internal",
  "mcp.internal",
  "programmatic.internal",
  "delegate.internal",
  "sandbox.internal",
] as const;

export interface ContainerEgressProps {
  /** `ctx.id.toString()` of the HarnessDO that registered the intercept. */
  readonly harness: string;
}

/**
 * Egress of the harness containers. HarnessDO registers it for every host above with its
 * own id in the props, so a container reaches only the object that owns it, and the
 * assignment stays the authorization boundary of every request.
 */
export class ContainerEgress extends WorkerEntrypoint<ContainerBindings, ContainerEgressProps> {
  override fetch(request: Request): Promise<Response> {
    const namespace = this.env.HARNESS;
    const harness = namespace.get(namespace.idFromString(this.ctx.props.harness));
    switch (new URL(request.url).hostname) {
      case "model.internal":
        return harness.modelRequest(request);
      case "media.internal":
        return harness.mediaRequest(request);
      case "mcp.internal":
        return harness.mcpRequest(request);
      case "programmatic.internal":
        return harness.programmaticRequest(request);
      case "delegate.internal":
        return harness.delegateRequest(request);
      case "sandbox.internal":
        return harness.fetch(request);
      default:
        return Promise.resolve(new Response("Unknown egress host", { status: 404 }));
    }
  }
}

export interface SandboxEgressProps {
  /** Hostname patterns the sandbox may reach; `*` matches any run of characters. */
  readonly allowed: readonly string[];
}

const matches = (pattern: string, hostname: string): boolean =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  ).test(hostname);

/**
 * Egress of a sandbox under a `restricted` network policy: every HTTP and HTTPS request
 * the container sends arrives here, and only the allowed hostnames reach the Internet.
 * A refusal answers 520 like the Sandbox SDK's policy did.
 */
export class SandboxEgress extends WorkerEntrypoint<ContainerBindings, SandboxEgressProps> {
  override fetch(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname.replace(/\.+$/, "");
    if (this.ctx.props.allowed.some((pattern) => matches(pattern, hostname))) return fetch(request);
    return Promise.resolve(new Response("Origin is disallowed", { status: 520 }));
  }
}

/**
 * A class the deployment's main module exports, as `ctx.exports` exposes it. The names are
 * part of the deployment contract: `defineAgentWorker` returns the classes under them.
 */
export function exported<T>(ctx: DurableObjectState, name: string): T {
  const exports = ctx.exports as unknown as Readonly<Record<string, T | undefined>> | undefined;
  const value = exports?.[name];
  if (value === undefined)
    throw new ContainerMisconfigured({
      reason: `Export ${name} from the Worker's main module; defineAgentWorker returns it`,
    });
  return value;
}

/** The entrypoint loopback `ctx.exports` builds for a `WorkerEntrypoint` export, with props. */
export type EntrypointLoopback<Props> = (options: { props: Props }) => Fetcher;
