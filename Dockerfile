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

# Backend listens on $PORT (default 8080). Dokploy maps its domain -> this port
# over HTTP(S)/wss -- that reverse-proxy path handles voice/manual control on
# its own.
#
# ArUco tracking / the live camera preview are DIFFERENT: the ESP32 sends
# Tello's video as raw UDP directly to VIDEO_PORT (default 8890, see
# VIDEO_HOST/VIDEO_PORT in firmware/src/config.h), bypassing the wss relay
# entirely -- see README.md's "ArUco marker-follow" section. EXPOSE below is
# documentation only; it does NOT publish the port. A typical Dokploy/Traefik
# HTTP domain mapping does not forward arbitrary UDP ports, so this port must
# be published SEPARATELY at the host level (Dokploy's port-mapping UI / a
# manual `docker run -p 8890:8890/udp` / a firewall rule opening inbound UDP
# 8890) or the ESP32's video relay never reaches the container and tracking
# silently never sees a frame.
ENV PORT=8080
EXPOSE 8080
EXPOSE 8890/udp

# Lightweight healthcheck hitting /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 || exit 1

CMD ["bun", "run", "src/server.ts"]
