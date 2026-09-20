/** What a new project starts from: the bare API Worker, or the Hono demo app around it. */
export type Template = "minimal" | "demo";
export const TEMPLATES: readonly Template[] = ["minimal", "demo"];

export interface SkeletonInput {
  name: string;
  compatibilityDate: string;
  template: Template;
}

/**
 * Whether the template publishes on a workers.dev subdomain. The demo is a page meant to
 * be opened in a browser; the minimal Worker is an API reached over Service Bindings
 * unless the deployment adds a route. Wrangler defaults to `true` when the key is absent,
 * so it is always written. Change it in wrangler.jsonc when deploying.
 */
export const WORKERS_DEV: Record<Template, boolean> = { minimal: false, demo: true };

/** The Wrangler entry each template starts from. */
export const ENTRY_FILES: Record<Template, string> = {
  minimal: "src/index.ts",
  demo: "src/index.tsx",
};

/** A minimal Wrangler configuration; `upsertWranglerConfig` adds the bindings. */
export function wranglerSkeleton(input: SkeletonInput): string {
  return `${JSON.stringify(
    {
      $schema: "node_modules/wrangler/config-schema.json",
      name: input.name,
      workers_dev: WORKERS_DEV[input.template],
      preview_urls: false,
      main: ENTRY_FILES[input.template],
      compatibility_date: input.compatibilityDate,
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
        // wrangler's default output is worker-configuration.d.ts; tsconfig and .gitignore name env.d.ts.
        types: "wrangler types env.d.ts",
      },
    },
    null,
    2,
  )}\n`;
}

export function tsconfigSkeleton(template: Template): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "Bundler",
        ...(template === "demo" ? { jsx: "react-jsx", jsxImportSource: "hono/jsx" } : {}),
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
