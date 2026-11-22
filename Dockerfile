# syntax=docker/dockerfile:1.7
#
# Hosted Bakbak MCP server: `bakbak-mcp --http` as one bundled file on Node 24.
#
#   docker build -t bakbak-mcp .

# Base images are pinned by digest (node:24-slim); update the digest deliberately.

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src/bakbak-mcp
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund \
    && node scripts/bundle.mjs /out/server.mjs

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    AUDIO_DIR=/data/audio
WORKDIR /app
COPY --from=build /out/server.mjs ./server.mjs
COPY LICENSE ./
RUN mkdir -p /data/audio && chown node:node /data/audio
USER node
EXPOSE 8080
VOLUME ["/data/audio"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "server.mjs", "--http"]
