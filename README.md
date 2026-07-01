# tellovoice — voice-controlled DJI Tello over a cloud backend

Speak a flight command into a phone browser; a cloud backend turns it into a
structured Tello command via Gemini and relays it to an ESP32-S3 on the phone's
hotspot, which drives the drone over UDP.

```mermaid
graph LR
  B[Phone browser<br/>wss] -->|audio / command| S[Backend<br/>Bun + TS]
  S -->|Gemini function calling| G[structured command]
  S -->|cmd over wss| E[ESP32-S3]
  E -->|UDP 8889| T[Tello / RMTT]
  E -.result / telemetry.-> S -.status / tello.-> B
  BTN([hardware LAND button]) --> E
```

## Why this shape

- **Browser needs a secure context** (`getUserMedia`, and no mixed content), so it
  talks only to the backend over real HTTPS/`wss` — no per-device certificate pain.
- **ESP32 is behind the phone hotspot NAT**, so it *dials out* to the backend
  (`wss` client) and the backend pushes commands down that socket. The backend can
  never connect to the ESP32 first.
- **Safety never depends on the internet.** The ESP32 handles keepalive locally
  (idle `battery?` every 5 s to dodge Tello's 15 s no-command auto-land) and a
  **physical LAND button** sends `land` straight to the Tello over UDP even if the
  backend, cellular, or Wi-Fi uplink is down.

## Layout

| Path | What |
|---|---|
| `src/protocol.ts` | **Frozen wire contract** shared by all three tiers. Start here. |
| `src/server.ts` | Bun HTTP + dual WebSocket server (`/ws/browser`, `/ws/device`), relay + status. |
| `src/gemini.ts` | Audio → one `control_drone` function call (Gemini). |
| `src/tello.ts` | Command validation + mapping to Tello SDK strings; reply parsing. |
| `src/*.test.ts` | Unit (mapping) + end-to-end plumbing (real subprocess, simulated browser+device). |
| `public/index.html` | Self-contained mobile web app (mic, controls, emergency LAND, status). |
| `firmware/` | PlatformIO ESP32-S3 project. See `firmware/README.md`. |

## Run the backend

```bash
bun install
cp .env.example .env      # set GEMINI_API_KEY, DEVICE_TOKEN, BROWSER_TOKEN
bun run start             # or: bun run dev  (watch mode)
```

- Open `http://<host>:<PORT>/?token=<BROWSER_TOKEN>`.
- `GET /health` reports `{ ok, deviceOnline, battery }`.
- Voice needs `GEMINI_API_KEY`; without it the buttons still fly the drone.

### Production (secure context)

The phone browser must load over **HTTPS** and connect over **wss** (mic + no mixed
content). Put the backend behind a TLS terminator with a real certificate — e.g. a
managed platform (Cloud Run / Fly / Render) or nginx/Caddy with Let's Encrypt.
Given a 1 GbE backend host, the extra internet hop for command relay adds only
~100–300 ms on top of the (dominant) STT+LLM latency.

## Tests

```bash
bun test          # unit + e2e plumbing (no Gemini key required)
bun run typecheck # tsc --noEmit
```

The plumbing test spawns the real server and drives a simulated browser and ESP32
over WebSocket, asserting the full relay round-trip, battery status, telemetry
broadcast, and pre-dispatch validation.

## Firmware & drone setup

See **`firmware/README.md`** for the ESP32-S3 build, the emergency-button wiring
(GPIO0 → GND), the `setInsecure()` TLS caveat, and the one-time Tello **`ap`**
command that joins the drone to the phone hotspot in station mode.

### Field checklist (verify before relying on the demo)

1. **Phone hotspot is 2.4 GHz** (Tello is 2.4 GHz-only; iOS: "Maximize Compatibility").
2. **Hotspot SSID is alphanumeric**, no spaces/Korean/symbols (Tello `ap` rejects them).
3. **Client isolation is OFF** — ESP32 and Tello must reach each other on the hotspot
   LAN. Confirm by watching for the firmware's `tello_found` event / a `battery?` reply.
4. **Turn off iCloud Private Relay / VPN** on the phone (breaks local + relay routing).
5. **Emergency LAND button works with Wi-Fi/backend pulled** (the real safety backstop).

## Command set

`takeoff`, `land`, `emergency`, `up/down/left/right/forward/back {20–500 cm}`,
`cw/ccw {1–360°}`, `flip {l/r/f/b}`, `battery?`. Out-of-range args are rejected
(not clamped) before dispatch — the drone never flies a distance you didn't say.

# Drone-Web-Server
