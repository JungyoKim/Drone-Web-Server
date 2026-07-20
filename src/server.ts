import type { ServerWebSocket } from "bun";
import { config } from "./config.ts";
import { mapCommand, parseTelloReply } from "./tello.ts";
import { parseAudioCommand, pingText, describeCommand } from "./gemini.ts";
import {
  TrackingSession,
  VideoPreviewSession,
  registerCustomMarker,
  CUSTOM_MARKER_DICT_NAME,
  CUSTOM_MARKER_BITS,
  type SteeringResult,
  type SteeringConfig,
  type PreviewConfig,
} from "./tracking.ts";
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
  /** Resolves when the Tello reply (or timeout) settles, for sequential runs. */
  resolve: (r: { ok: boolean; response: string }) => void;
}

// ---------- Registries ----------

const browsers = new Set<Socket>();
/** Single active device for this demo (last authenticated wins). */
let device: Socket | null = null;
let deviceAuthed = false;
let lastBattery: number | null = null;
/** Best-effort inference from observed takeoff/land/emergency replies --
 * null (unknown) until the first such reply lands this session. Tello
 * itself silently ignores `rc` before takeoff (verified: no safety risk,
 * just a no-op), so this exists purely to stop tracking mode from being a
 * confusing silent no-op -- see the warning in startTracking() below. */
let isFlying: boolean | null = null;
/** Currently active web-drawn custom marker (16-cell, row-major), or null to
 * use the statically configured dictionary/target id. Registered into
 * js-aruco2 via registerCustomMarker() as soon as it's set (cheap, pure
 * bookkeeping); actually TAKING EFFECT for detection requires the next
 * startTracking() call, since that's when a fresh AR.Detector is built. */
let customMarkerPattern: boolean[] | null = null;

const pending = new Map<number, PendingCommand>();
let nextCommandId = 1;

/** Active multi-command sequence (if any). Emergency / new input aborts it so
 * queued commands stop firing. */
let currentSeq: { aborted: boolean } | null = null;
function abortSequence(): void {
  if (currentSeq) { currentSeq.aborted = true; currentSeq = null; }
}

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
  broadcastBrowsers({
    type: "status",
    deviceOnline: deviceAuthed && device !== null,
    battery: lastBattery,
    isFlying,
  });
}
function broadcastMarkerPattern(): void {
  broadcastBrowsers({ type: "marker_pattern", pattern: customMarkerPattern });
}

// ---------- Command dispatch ----------

type DispatchResult = { ok: boolean; response: string };

/**
 * Validate a structured command, push it to the device, and register a pending
 * reply so the eventual Tello response is relayed back to `origin`.
 * Returns `{ error }` if validation failed (nothing dispatched), else `{ done }`
 * — a promise that resolves when the Tello reply (or timeout) settles, so a
 * multi-command sequence can wait for each step before sending the next.
 */
function dispatch(command: DroneCommand, origin: Socket | null): { error: string } | { done: Promise<DispatchResult> } {
  const mapped = mapCommand(command);
  if (!mapped.ok) return { error: mapped.error };

  if (!device || !deviceAuthed) return { error: "device offline" };

  const id = nextCommandId++;
  let resolve!: (r: DispatchResult) => void;
  const done = new Promise<DispatchResult>((res) => { resolve = res; });
  const timer = setTimeout(() => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.origin) sendBrowser(p.origin, { type: "tello", command: p.command, response: "timeout", ok: false });
    p.resolve({ ok: false, response: "timeout" });
  }, config.commandTimeoutMs);

  pending.set(id, { command: mapped.command, origin, timer, resolve });
  sendDevice(device, { type: "command", id, tello: mapped.tello, meta: mapped.command });
  return { done };
}

export type SequenceStop = "done" | "aborted" | "failed" | "error";

/**
 * Run commands strictly in order, one at a time. Safety-critical:
 * - stops before each step if `seq.aborted` (emergency / new input),
 * - re-checks abort after each step (abort can land while awaiting a reply),
 * - stops the rest if a step fails (Tello rejected / timeout) or errors.
 * `run` dispatches one command and resolves with its outcome; `onStop` reports
 * why the run ended (for UI). Pure of transport — unit-testable with a fake run.
 */
export async function runCommandSequence(
  commands: DroneCommand[],
  seq: { aborted: boolean },
  run: (cmd: DroneCommand, index: number, total: number) => Promise<{ ok: boolean } | { error: string }>,
  onStop?: (reason: SequenceStop, cmd?: DroneCommand) => void,
): Promise<{ executed: number; reason: SequenceStop }> {
  const total = commands.length;
  let executed = 0;
  for (let i = 0; i < total; i++) {
    const cmd = commands[i]!;
    if (seq.aborted) { onStop?.("aborted", cmd); return { executed, reason: "aborted" }; }
    const res = await run(cmd, i, total);
    if ("error" in res) { onStop?.("error", cmd); return { executed, reason: "error" }; }
    executed++;
    if (seq.aborted) { onStop?.("aborted", cmd); return { executed, reason: "aborted" }; }
    if (!res.ok) { onStop?.("failed", cmd); return { executed, reason: "failed" }; }
  }
  onStop?.("done");
  return { executed, reason: "done" };
}

// ---------- ArUco marker-follow ----------

let trackingActive = false;
let trackingSession: TrackingSession | null = null;
let previewSession: VideoPreviewSession | null = null;
let trackRcTimer: ReturnType<typeof setInterval> | null = null;
let lastSteering: SteeringResult | null = null;
let lastSteeringAtMs = 0;
/** No fresh detected frame within this window -> failsafe to rc 0 0 0 0 rather
 * than keep repeating a stale command (video pipe stalled / marker occluded). */
const STEERING_STALE_MS = 500;
/** Send cadence for `rc`, matching the Tello SDK's recommended 5-10 Hz. Decoupled
 * from actual video frame rate so a fast decoder can't flood the device link. */
const RC_SEND_INTERVAL_MS = 100;

const steeringConfig: SteeringConfig = {
  frameWidth: config.videoWidth,
  frameHeight: config.videoHeight,
  dictionaryName: config.arucoDictionary,
  targetMarkerId: config.arucoTargetId,
  targetSizePx: config.arucoTargetSizePx,
  maxRc: config.trackMaxRc,
  yawGain: config.trackYawGain,
  altGain: config.trackAltGain,
  distGain: config.trackDistGain,
};

const previewConfig: PreviewConfig = {
  width: config.videoPreviewWidth,
  quality: config.videoPreviewQuality,
  maxFps: config.videoPreviewMaxFps,
};

/** Stop tracking unconditionally: safe to call when already stopped (idempotent),
 * from an emergency event, a manual command, `{type:"track",on:false}`, or device
 * disconnect. Always zeroes rc before tearing down so the drone never keeps the
 * last commanded velocity. */
function stopTracking(): void {
  if (!trackingActive && !trackingSession && !previewSession && !trackRcTimer) return;
  trackingActive = false;
  if (trackRcTimer) { clearInterval(trackRcTimer); trackRcTimer = null; }
  if (device && deviceAuthed) sendDevice(device, { type: "rc", a: 0, b: 0, c: 0, d: 0 });
  trackingSession?.stop();
  trackingSession = null;
  previewSession?.stop();
  previewSession = null;
  lastSteering = null;
  if (device && deviceAuthed) {
    const r = dispatch({ action: "streamoff" }, null);
    if ("done" in r) void r.done;
  }
  broadcastBrowsers({ type: "tracking", active: false, markerFound: false });
}

/** Start tracking: streamon -> spawn a decode/detect session -> begin the rc
 * send loop. Idempotent (no-op if already active). Any failure leaves tracking
 * off and reports an error to the requesting browser. */
async function startTracking(ws: Socket): Promise<void> {
  if (!device || !deviceAuthed) { sendBrowser(ws, { type: "error", message: "device offline" }); return; }
  if (trackingActive) return;
  abortSequence(); // starting tracking supersedes any running voice sequence
  const r = dispatch({ action: "streamon" }, ws);
  if ("error" in r) { sendBrowser(ws, { type: "error", message: r.error }); return; }
  const res = await r.done;
  if (!res.ok) { sendBrowser(ws, { type: "error", message: `streamon 실패: ${res.response}` }); return; }

  // Tello silently ignores `rc` before takeoff (verified -- not a safety
  // issue, just a no-op), so tracking would otherwise look "on" (marker
  // detected, rc computed) while the drone never actually moves. Only warn
  // when we're SURE it hasn't flown (isFlying === false) -- an unknown
  // state (null, e.g. right after reconnect) isn't worth nagging about.
  if (isFlying === false) {
    sendBrowser(ws, {
      type: "error",
      message: "드론이 아직 이륙하지 않았습니다 — 마커를 따라가려면 먼저 이륙하세요.",
    });
  }

  // A web-drawn custom pattern (see set_marker) overrides the statically
  // configured dictionary/target-id for this session -- registerCustomMarker
  // already (re-)registered it into js-aruco2 when it was set, so this just
  // needs to point the fresh AR.Detector at that dictionary, always id 0
  // (a custom dictionary holds exactly one marker).
  const sessionSteeringConfig: SteeringConfig = customMarkerPattern
    ? { ...steeringConfig, dictionaryName: CUSTOM_MARKER_DICT_NAME, targetMarkerId: 0 }
    : steeringConfig;
  trackingSession = new TrackingSession(
    sessionSteeringConfig,
    (result) => {
      lastSteering = result;
      lastSteeringAtMs = Date.now();
      broadcastBrowsers({
        type: "tracking",
        active: true,
        markerFound: result.markerFound,
        markerId: result.markerId,
        dx: result.dx,
        dy: result.dy,
        sizeRatio: result.sizeRatio,
        rc: result.rc,
      });
    },
    (err) => console.error("[track] session error:", err),
  );
  trackingSession.start();

  previewSession = new VideoPreviewSession(
    previewConfig,
    (jpeg) => {
      broadcastBrowsers({ type: "frame", jpeg: Buffer.from(jpeg).toString("base64") });
    },
    (err) => console.error("[preview] session error:", err),
  );
  previewSession.start();
  trackingActive = true;
  // Immediate feedback -- don't leave the browser's toggle in limbo until the
  // first frame decodes (which may be seconds away, or never if the ESP32's
  // video relay / Tello's streamon-in-station-mode isn't actually delivering).
  broadcastBrowsers({ type: "tracking", active: true, markerFound: false });

  trackRcTimer = setInterval(() => {
    if (!trackingActive || !device || !deviceAuthed) return;
    const fresh = lastSteering !== null && (Date.now() - lastSteeringAtMs) < STEERING_STALE_MS;
    const rc = fresh ? lastSteering!.rc : { a: 0, b: 0, c: 0, d: 0 };
    sendDevice(device, { type: "rc", ...rc });
  }, RC_SEND_INTERVAL_MS);
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
      abortSequence(); // manual input supersedes any running sequence
      stopTracking();  // ...including autonomous marker-follow
      const r = dispatch(msg.command, ws);
      if ("error" in r) sendBrowser(ws, { type: "error", message: r.error });
      return;
    }

    case "track": {
      if (msg.on) void startTracking(ws);
      else stopTracking();
      return;
    }

    case "set_marker": {
      if (!Array.isArray(msg.pattern) || msg.pattern.length !== CUSTOM_MARKER_BITS || !msg.pattern.every((b) => typeof b === "boolean")) {
        sendBrowser(ws, { type: "error", message: `마커 패턴은 ${CUSTOM_MARKER_BITS}칸(4x4) boolean 배열이어야 합니다` });
        return;
      }
      try {
        registerCustomMarker(msg.pattern, config.arucoCustomTau);
      } catch (e) {
        sendBrowser(ws, { type: "error", message: `마커 등록 실패: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      customMarkerPattern = msg.pattern;
      broadcastMarkerPattern();
      broadcastBrowsers({ type: "info", message: "커스텀 마커가 설정되었습니다 -- 다음 추적 시작부터 적용됩니다" });
      return;
    }

    case "clear_marker": {
      customMarkerPattern = null;
      broadcastMarkerPattern();
      broadcastBrowsers({ type: "info", message: "커스텀 마커가 해제되었습니다 (기본 딕셔너리로 복귀)" });
      return;
    }

    case "audio": {
      if (!config.geminiApiKey) {
        sendBrowser(ws, { type: "error", message: "voice disabled: GEMINI_API_KEY not set" });
        return;
      }
      console.log(`[audio] received mime=${msg.mime} bytes=${msg.audio?.length ?? 0}`);
      try {
        const { commands, heard } = await parseAudioCommand(msg.audio, msg.mime);
        if (heard) sendBrowser(ws, { type: "transcript", text: heard });
        if (commands.length === 0) {
          sendBrowser(ws, { type: "error", message: "명령을 인식하지 못했습니다" });
          return;
        }
        // Start a fresh sequence, cancelling any previous one still running.
        abortSequence();
        stopTracking();
        const seq = { aborted: false };
        currentSeq = seq;
        await runCommandSequence(commands, seq, (cmd, i, total) => {
          const label = total > 1 ? `[${i + 1}/${total}] ${describeCommand(cmd)}` : describeCommand(cmd);
          sendBrowser(ws, { type: "parsed", command: cmd, raw: label });
          const r = dispatch(cmd, ws);
          if ("error" in r) { sendBrowser(ws, { type: "error", message: r.error }); return Promise.resolve({ error: r.error }); }
          return r.done;
        }, (reason, cmd) => {
          if (reason === "aborted") sendBrowser(ws, { type: "error", message: "시퀀스 취소됨" });
          else if (reason === "failed" && commands.length > 1) sendBrowser(ws, { type: "error", message: `중단: '${describeCommand(cmd!)}' 실패` });
        });
        if (currentSeq === seq) currentSeq = null;
      } catch (e) {
        console.error(`[audio] parse failed:`, e);
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
      // Infer flight state from discrete commands that change it. Emergency
      // always cuts motors (grounds it) regardless of what Tello replies;
      // takeoff/land only count on an actual "ok".
      if (p.command.action === "emergency") isFlying = false;
      else if (parsed.ok && p.command.action === "takeoff") isFlying = true;
      else if (parsed.ok && p.command.action === "land") isFlying = false;
      const ok = msg.ok && parsed.ok;
      if (p.origin) {
        sendBrowser(p.origin, { type: "tello", command: p.command, response: msg.response, ok });
      }
      if (p.command.action === "battery" || p.command.action === "takeoff" || p.command.action === "land" || p.command.action === "emergency") {
        broadcastStatus();
      }
      p.resolve({ ok, response: msg.response }); // unblock a waiting sequence step
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
      // Hardware events. Emergency button lands the drone directly over UDP;
      // also cancel any queued multi-command sequence so nothing else fires.
      if (msg.event === "emergency_button") {
        abortSequence();
        stopTracking();
        isFlying = false;
        broadcastStatus();
        broadcastBrowsers({ type: "error", message: "비상 착륙 버튼이 눌렸습니다" });
        return;
      }
      // tello_found / tello_lost are routine discovery status, not failures
      // -- surface via "info" so the UI doesn't red-toast a normal "found
      // the drone" event.
      const label = msg.event === "tello_found" ? "Tello 드론 발견됨" : "Tello 드론 연결 끊김";
      broadcastBrowsers({ type: "info", message: `${label}${msg.detail ? ` (${msg.detail})` : ""}` });
      return;
    }

    case "pong":
      return;
  }
}

// ---------- Video ingest (ArUco tracking) ----------
// Raw UDP relay from the ESP32 (Tello's own UDP:11111 stream, forwarded verbatim
// -- see protocol.ts's comment on the `rc` ServerToDevice message for why this is
// out of band from the WS JSON protocol). A no-op when no session is active.
// Failing to bind must not take down voice/button control, so this degrades to a
// warning rather than crashing the module.
try {
  await Bun.udpSocket({
    port: config.videoPort,
    socket: {
      data(_socket, buf) {
        trackingSession?.feedVideoChunk(buf);
        previewSession?.feedVideoChunk(buf);
      },
    },
  });
  console.log(`[track] video UDP listener on :${config.videoPort}`);
} catch (e) {
  console.error(`[track] failed to bind video UDP port ${config.videoPort} -- marker tracking disabled:`, e);
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

    // Voice connectivity probe. Raw fetches pinpoint the failing layer:
    // general egress, DNS/reachability to Google, then the actual Gemini call.
    if (url.pathname === "/selftest") {
      async function probe(label: string, target: string, ms: number) {
        const t0 = Date.now();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), ms);
        try {
          const r = await fetch(target, { signal: ac.signal });
          return { label, ok: true, status: r.status, ms: Date.now() - t0 };
        } catch (e) {
          return { label, ok: false, error: (e as Error).message, ms: Date.now() - t0 };
        } finally {
          clearTimeout(timer);
        }
      }
      const key = config.geminiApiKey;
      const results = {
        internet: await probe("internet", "https://www.gstatic.com/generate_204", 8000),
        geminiReST: await probe(
          "gemini-rest",
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key || "none"}`,
          10000,
        ),
        geminiSDK: key ? await pingText() : { ok: false, error: "GEMINI_API_KEY not set" },
        model: config.geminiModel,
      };
      return Response.json(results);
    }

    // Static web app (Vite build output) -- SPA, so any unmatched path that
    // isn't a literal static asset falls back to index.html and lets
    // react-router take over client-side (e.g. a direct nav/refresh on
    // /track). Real static files (JS/CSS/fonts under /assets, favicon, etc.)
    // are served as-is when they exist.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`public${path}`);
    if (await file.exists()) return new Response(file);
    const index = Bun.file("public/index.html");
    if (await index.exists()) return new Response(index);
    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      if (ws.data.role === "browser") {
        browsers.add(ws);
        sendBrowser(ws, {
          type: "status",
          deviceOnline: deviceAuthed && device !== null,
          battery: lastBattery,
          isFlying,
        });
        sendBrowser(ws, { type: "marker_pattern", pattern: customMarkerPattern });
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
        isFlying = null; // unknown once the link is gone
        stopTracking();
        broadcastStatus();
      }
    },
  },
});

console.log(`tellovoice backend on :${server.port}  (voice ${config.geminiApiKey ? "ON" : "OFF"})`);

export { server };
