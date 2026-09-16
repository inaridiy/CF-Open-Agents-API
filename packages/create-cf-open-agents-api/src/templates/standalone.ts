export interface SkeletonInput {
  name: string;
  /** `workers_dev: true` publishes the HTTP API on a workers.dev subdomain. */
  publicRoute: boolean;
  today: string;
}

/** A minimal Wrangler configuration; `upsertWranglerConfig` adds the bindings. */
export function wranglerSkeleton(input: SkeletonInput): string {
  return `${JSON.stringify(
    {
      $schema: "node_modules/wrangler/config-schema.json",
      name: input.name,
      workers_dev: input.publicRoute,
      preview_urls: false,
      main: "src/index.ts",
      compatibility_date: input.today,
      compatibility_flags: ["nodejs_compat"],
      observability: { enabled: true, traces: { enabled: true } },
    },
    null,
    2,
  )}\n`;
}

/** Name, scripts and nothing else; `ensurePackageJson` adds the pinned dependencies. */
export function packageSkeleton(input: SkeletonInput): string {
  return `${JSON.stringify(
    {
      name: input.name,
      private: true,
      type: "module",
      scripts: {
        dev: "wrangler dev",
        deploy: "wrangler deploy",
        types: "wrangler types",
      },
    },
    null,
    2,
  )}\n`;
}

export function tsconfigSkeleton(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["@cloudflare/workers-types"],
      },
      include: ["src", "env.d.ts"],
    },
    null,
    2,
  )}\n`;
}

export function gitignoreSkeleton(): string {
  return ["node_modules/", ".wrangler/", "env.d.ts", ""].join("\n");
}
