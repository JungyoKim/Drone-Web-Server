# tellovoice frontend

Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui. See the repo root
[`README.md`](../README.md) for the full run/build/deploy instructions —
this file only covers frontend-specific notes.

## Layout

| Path | What |
|---|---|
| `src/hooks/useDroneSocket.ts` | The entire WebSocket layer (connect/reconnect/token/ping/dispatch). Components are pure consumers. |
| `src/lib/ws-protocol.ts` | Type-only re-export of `../../src/protocol.ts` (the backend's wire contract) — the only file that crosses the two project roots. |
| `src/components/` | `ConnectionHeader`, `CommandLog`, `VoiceRecorder`, `ManualControls`, `TrackingPanel` — each a pure prop-driven component. |
| `src/components/ui/` | shadcn/ui primitives (generated, edit freely — they're vendored into the repo, not an npm dependency). |
| `src/App.tsx` | Routing (`react-router`) + layout assembly. |

## Commands

```bash
bun install
bun dev      # HMR dev server on :5173, proxies /ws + /health + /selftest to a
             # backend running separately on :8080 (see vite.config.ts)
bun run build  # tsc -b && vite build -> ../public/ (what the Dockerfile ships)
bun run lint   # oxlint
```

## Adding a shadcn component

⚠️ On this Windows dev machine, `shadcn add <name>` has a known CLI bug: it
writes new files to a literal `./@/...` directory instead of resolving the
`@/*` alias to `./src/*`. After running it, check for a stray `web/@/` folder
and move its contents into the matching `src/` path, e.g.:

```bash
mv "@/components/ui/"*.tsx src/components/ui/
rm -rf "@"
```
