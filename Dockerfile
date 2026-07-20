# tellovoice backend — Bun. Deployable on Dokploy (Nixpacks or Dockerfile mode).
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
COPY public ./public

# Backend listens on $PORT (default 8080). Dokploy maps its domain -> this port.
ENV PORT=8080
EXPOSE 8080

# Lightweight healthcheck hitting /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 || exit 1

CMD ["bun", "run", "src/server.ts"]
