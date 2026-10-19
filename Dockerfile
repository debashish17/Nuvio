# Nuvio Remit MCP server: multi-stage build on node:22-alpine (CLAUDE.md toolchain).
# Runtime config comes from the environment (see .env.example); no secrets are baked in.

ARG NODE_IMAGE=node:22-alpine

# ---- base: pnpm (version pinned by package.json "packageManager") + native build tools ----
FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN npm install -g pnpm@12.8.1 \
 && apk add --no-cache python3 make g++
# better-sqlite3 compiles from source when no musl prebuild matches; allowed in pnpm-workspace.yaml.

# ---- build: full install, bundle with tsup (copies schema.sql + migrations into dist/) ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Workspace manifests too: the lockfile lists every workspace package (packages/mcp-confirm-gate).
COPY packages/mcp-confirm-gate/package.json packages/mcp-confirm-gate/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json tsup.config.ts ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm build

# ---- prod-deps: runtime dependencies only (tsup leaves node_modules packages external) ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Workspace manifests too: the lockfile lists every workspace package (packages/mcp-confirm-gate).
COPY packages/mcp-confirm-gate/package.json packages/mcp-confirm-gate/
RUN pnpm install --frozen-lockfile --prod

# ---- runtime: no compilers, no dev dependencies, non-root ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/nuvio-remit.db
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# The SQLite ledger lives on the instance; App Runner runs exactly one, and a deploy starts from the seed.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD ["node", "dist/index.js"]
