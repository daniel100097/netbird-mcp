# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app
RUN chown bun:bun /app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS development
COPY . .
USER bun
CMD ["bun", "--watch", "src/index.ts"]

FROM development AS test
CMD ["bun", "run", "check"]

FROM test AS build
RUN bun run check && bun run build

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production \
    MCP_TRANSPORT=stdio \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json README.md LICENSE THIRD_PARTY_NOTICES.md ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["bun", "dist/healthcheck.js"]
ENTRYPOINT ["bun", "dist/index.js"]
