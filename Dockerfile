# tellovoice — Bun backend + Vite/React frontend. Deployable on Dokploy.

# ---- Stage 1: build the frontend (Vite + React + shadcn/ui) ----
FROM oven/bun:1.3-alpine AS web-build
WORKDIR /app
# web/src/lib/ws-protocol.ts imports ../../../src/protocol.ts (single source
# of truth for the wire contract) -- copy both trees in the same relative
# layout the source tree uses, so that import resolves during the build.
COPY src ./src
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile
COPY web ./web
RUN cd web && bun run build

# ---- Stage 2: backend runtime ----
FROM oven/bun:1.3-alpine

# ffmpeg decodes the ESP32's relayed Tello H.264 video for ArUco marker tracking.
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source.
COPY tsconfig.json ./
COPY src ./src

# Built frontend (static files) -- server.ts serves this as `public/`.
COPY --from=web-build /app/web/dist ./public

# Backend listens on $PORT (default 8080). Dokploy maps its domain -> this port.
ENV PORT=8080
EXPOSE 8080

# Lightweight healthcheck hitting /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 || exit 1

CMD ["bun", "run", "src/server.ts"]
