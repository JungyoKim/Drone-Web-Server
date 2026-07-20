import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Allow importing src/protocol.ts from the repo root (single source of
    // truth for the WS wire contract, shared with the Bun backend) -- it
    // lives outside Vite's default project-root file-serving allowlist.
    fs: {
      allow: [path.resolve(__dirname, "."), path.resolve(__dirname, "..")],
    },
    // Dev workflow: `bun dev` here (HMR) talks to a separately-running
    // backend (`bun run dev` at the repo root, port 8080 by default) via
    // this proxy, since the app hits relative /ws/browser + /health etc.
    // against `location.host`. Override BACKEND_PORT if the backend runs
    // elsewhere. Production doesn't use this -- the backend serves the
    // built `dist/` directly, same origin, no proxy needed.
    proxy: {
      "/ws": { target: `ws://localhost:${process.env.BACKEND_PORT ?? 8080}`, ws: true },
      "/health": `http://localhost:${process.env.BACKEND_PORT ?? 8080}`,
      "/selftest": `http://localhost:${process.env.BACKEND_PORT ?? 8080}`,
    },
  },
});
