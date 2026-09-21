FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.1.2
# Only what the supervisor needs: itself, its workspace dependency and the workspace root
# (which owns the TypeScript toolchain and the compiler options both build files extend).
# Nothing else in the repository can break this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/agent-api ./packages/agent-api
COPY packages/supervisor ./packages/supervisor
RUN pnpm install --frozen-lockfile --filter cf-open-agents-api-supervisor... --filter . \
    && pnpm --filter cf-open-agents-api-supervisor... build \
    && pnpm --filter cf-open-agents-api-supervisor deploy --prod --legacy /out

FROM node:24.15.0-bookworm-slim
RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.154.0 opencode-ai@1.18.30
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /app/state && chown node:node /app/state
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
