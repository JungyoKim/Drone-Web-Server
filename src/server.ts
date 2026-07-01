import type { ServerWebSocket } from "bun";
import { config } from "./config.ts";
import { mapCommand, parseTelloReply } from "./tello.ts";
import { parseAudioCommand } from "./gemini.ts";
import type {
  BrowserToServer,
  ServerToBrowser,
  DeviceToServer,
  ServerToDevice,
  DroneCommand,
} from "./protocol.ts";

// ---------- Per-connection state ----------

type Role = "browser" | "device";
interface SocketData {
  role: Role;
  /** Set once a device authenticates. */
  deviceId?: string;
}
type Socket = ServerWebSocket<SocketData>;

/** A command dispatched to the device, awaiting its relayed Tello reply. */
interface PendingCommand {
  command: DroneCommand;
  /** Browser that should receive the relayed reply (may be gone by reply time). */
  origin: Socket | null;
  timer: ReturnType<typeof setTimeout>;
}

// ---------- Registries ----------

const browsers = new Set<Socket>();
/** Single active device for this demo (last authenticated wins). */
let device: Socket | null = null;
let deviceAuthed = false;
let lastBattery: number | null = null;

const pending = new Map<number, PendingCommand>();
let nextCommandId = 1;

// ---------- Send helpers (typed) ----------

function sendBrowser(ws: Socket, msg: ServerToBrowser): void {
  ws.send(JSON.stringify(msg));
}
function sendDevice(ws: Socket, msg: ServerToDevice): void {
  ws.send(JSON.stringify(msg));
}
function broadcastBrowsers(msg: ServerToBrowser): void {
  const s = JSON.stringify(msg);
  for (const ws of browsers) ws.send(s);
}
function broadcastStatus(): void {
  broadcastBrowsers({ type: "status", deviceOnline: deviceAuthed && device !== null, battery: lastBattery });
}

// ---------- Command dispatch ----------

/**
 * Validate a structured command, push it to the device, and register a pending
 * reply so the eventual Tello response is relayed back to `origin`.
 * Returns an error string if validation failed (nothing dispatched).
 */
function dispatch(command: DroneCommand, origin: Socket | null): string | null {
  const mapped = mapCommand(command);
  if (!mapped.ok) return mapped.error;

  if (!device || !deviceAuthed) return "device offline";

  const id = nextCommandId++;
  const timer = setTimeout(() => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.origin) sendBrowser(p.origin, { type: "tello", command: p.command, response: "timeout", ok: false });
  }, config.commandTimeoutMs);

  pending.set(id, { command: mapped.command, origin, timer });
  sendDevice(device, { type: "command", id, tello: mapped.tello, meta: mapped.command });
  return null;
}

// ---------- Browser message handling ----------

async function onBrowserMessage(ws: Socket, raw: string): Promise<void> {
  let msg: BrowserToServer;
  try {
    msg = JSON.parse(raw) as BrowserToServer;
  } catch {
    sendBrowser(ws, { type: "error", message: "invalid json" });
    return;
  }

  switch (msg.type) {
    case "ping":
      sendBrowser(ws, { type: "pong" });
      return;

    case "command": {
      const err = dispatch(msg.command, ws);
      if (err) sendBrowser(ws, { type: "error", message: err });
      return;
    }

    case "audio": {
      if (!config.geminiApiKey) {
        sendBrowser(ws, { type: "error", message: "voice disabled: GEMINI_API_KEY not set" });
        return;
      }
      try {
        const { command, raw: desc } = await parseAudioCommand(msg.audio, msg.mime);
        sendBrowser(ws, { type: "parsed", command, raw: desc });
        const err = dispatch(command, ws);
        if (err) sendBrowser(ws, { type: "error", message: err });
      } catch (e) {
        sendBrowser(ws, { type: "error", message: `parse failed: ${(e as Error).message}` });
      }
      return;
    }

    default:
      sendBrowser(ws, { type: "error", message: "unknown message" });
  }
}

// ---------- Device message handling ----------

function onDeviceMessage(ws: Socket, raw: string): void {
  let msg: DeviceToServer;
  try {
    msg = JSON.parse(raw) as DeviceToServer;
  } catch {
    return;
  }

  switch (msg.type) {
    case "hello": {
      if (msg.token !== config.deviceToken) {
        sendDevice(ws, { type: "welcome", ok: false, message: "bad token" });
        ws.close(1008, "auth");
        return;
      }
      ws.data.deviceId = msg.deviceId;
      device = ws;
      deviceAuthed = true;
      sendDevice(ws, { type: "welcome", ok: true });
      broadcastStatus();
      return;
    }

    case "result": {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      const parsed = parseTelloReply(msg.response);
      // battery? replies carry the level — cache it.
      if (p.command.action === "battery" && parsed.ok) lastBattery = Number(parsed.value);
      if (p.origin) {
        sendBrowser(p.origin, { type: "tello", command: p.command, response: msg.response, ok: msg.ok && parsed.ok });
      }
      if (p.command.action === "battery") broadcastStatus();
      return;
    }

    case "telemetry": {
      if (typeof msg.battery === "number") {
        lastBattery = msg.battery;
        broadcastStatus();
      }
      return;
    }

    case "event": {
      // Surface hardware events (esp. emergency button) to every browser.
      broadcastBrowsers({ type: "error", message: `device event: ${msg.event}${msg.detail ? ` (${msg.detail})` : ""}` });
      return;
    }

    case "pong":
      return;
  }
}

// ---------- HTTP + WS server ----------

const server = Bun.serve<SocketData>({
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/browser") {
      if (url.searchParams.get("token") !== config.browserToken) {
        return new Response("unauthorized", { status: 401 });
      }
      if (srv.upgrade(req, { data: { role: "browser" } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/ws/device") {
      // Device authenticates in its hello frame (token in body), not the query.
      if (srv.upgrade(req, { data: { role: "device" } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, deviceOnline: deviceAuthed, battery: lastBattery });
    }

    // Static web app.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`public${path}`);
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      if (ws.data.role === "browser") {
        browsers.add(ws);
        sendBrowser(ws, { type: "status", deviceOnline: deviceAuthed && device !== null, battery: lastBattery });
      }
    },
    message(ws, message) {
      const raw = typeof message === "string" ? message : message.toString();
      if (ws.data.role === "browser") void onBrowserMessage(ws, raw);
      else onDeviceMessage(ws, raw);
    },
    close(ws) {
      if (ws.data.role === "browser") {
        browsers.delete(ws);
      } else if (ws === device) {
        device = null;
        deviceAuthed = false;
        broadcastStatus();
      }
    },
  },
});

console.log(`tellovoice backend on :${server.port}  (voice ${config.geminiApiKey ? "ON" : "OFF"})`);

export { server };
