import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  computeSteering,
  createArucoDetector,
  pickTargetMarker,
  registerCustomMarker,
  CUSTOM_MARKER_DICT_NAME,
  DEFAULT_ARUCO_DICTIONARY,
  type ArucoDetector,
  type SteeringConfig,
  type SteeringResult,
} from "@/lib/tracking";
import { H264Stream } from "@/lib/h264decode";

// ---------- Config defaults (see local-track-protocol.md) ----------
// Hardcoded rather than env-driven -- this is a browser app with no
// server-side env, mirroring src/config.ts's ArUco/tracking defaults
// exactly (same values -- see that file's own doc comments for the
// reasoning behind each one).
const LOCAL_TRACK_PORT = 81;
const LOCAL_TRACK_PATH = "/track";
const DEFAULT_HOST = "tello.local"; // matches the ESP32's own MDNS.begin(CONFIG_HOST) hostname
const VIDEO_WIDTH = 960;
const VIDEO_HEIGHT = 720;
const ARUCO_CUSTOM_TAU = 2;
const ARUCO_TARGET_SIZE_PX = 160;
const TRACK_MAX_RC = 35;
const TRACK_YAW_GAIN = 60;
const TRACK_ALT_GAIN = 60;
const TRACK_DIST_GAIN = 80;

/** Send cadence for `rc`, decoupled from decode frame rate so a fast
 * decoder can't flood the ESP32/device link -- identical value and
 * reasoning to the backend's RC_SEND_INTERVAL_MS in server.ts. */
const RC_SEND_INTERVAL_MS = 100;
/** No fresh detection within this window -> failsafe to rc 0 0 0 0 rather
 * than repeat a stale command -- identical value and reasoning to the
 * backend's STEERING_STALE_MS. */
const STEERING_STALE_MS = 500;

const HOST_COOKIE = "tv_local_host";
const TOKEN_COOKIE = "tv_local_token";

export type LocalTrackConnState = "idle" | "connecting" | "connected" | "disconnected" | "error";

const CONN_LABELS: Record<LocalTrackConnState, string> = {
  idle: "연결 안 됨",
  connecting: "연결 중\u2026",
  connected: "연결됨",
  disconnected: "연결 끊김",
  error: "연결 오류",
};

/** Local-track telemetry -- mirrors the cloud `tracking` message's fields
 * (see useDroneSocket's TrackingState) for visual consistency between the
 * two tracking UIs, plus `rc` (the cloud panel doesn't surface rc; this one
 * does -- seeing the actual commanded channels matters more for a
 * low-latency channel being smoke-tested end to end). */
export interface LocalTrackTelemetry {
  active: boolean;
  markerFound: boolean;
  markerId?: number;
  dx: number;
  dy: number;
  sizeRatio?: number;
  rc: { a: number; b: number; c: number; d: number };
}

const IDLE_TELEMETRY: LocalTrackTelemetry = {
  active: false,
  markerFound: false,
  dx: 0,
  dy: 0,
  rc: { a: 0, b: 0, c: 0, d: 0 },
};

export interface LocalTrackState {
  connState: LocalTrackConnState;
  connLabel: string;
  telemetry: LocalTrackTelemetry;
}

function loadCookie(name: string): string {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]!).trim() : "";
  } catch {
    return "";
  }
}

function saveCookie(name: string, value: string): void {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    // 1 year; Lax so it rides same-site navigations -- same scheme as
    // useDroneSocket's saveToken, under distinct cookie names since this is
    // a SEPARATE credential (the ESP32's device token, not the browser
    // token the cloud connection uses).
    document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* ignore */
  }
}

interface UseLocalTrackOptions {
  /** Currently active custom marker pattern from the CLOUD connection (see
   * useDroneSocket's markerPattern) -- kept in sync so the local detector
   * uses the SAME dictionary the cloud path would, per
   * local-track-protocol.md. */
  markerPattern: boolean[] | null;
  /** Best-effort flight-state from the CLOUD connection (see
   * useDroneSocket's isFlying) -- gates sending non-zero rc so this
   * low-latency channel never streams movement commands the cloud path
   * doesn't believe are safe. */
  isFlying: boolean | null;
}

/** `{ type: "rc", a, b, c, d }` -- the ONLY message this channel ever
 * sends, per local-track-protocol.md. Defined locally (not in
 * ws-protocol.ts) because this is a NEW browser<->ESP32 wire contract with
 * no backend counterpart to cross-import from -- the local channel
 * bypasses the backend entirely. */
interface LocalRc {
  type: "rc";
  a: number;
  b: number;
  c: number;
  d: number;
}

const ZERO_RC = { a: 0, b: 0, c: 0, d: 0 };

/**
 * Owns the local (phone<->ESP32 direct) tracking data plane end to end:
 * connects to `ws://<host>:81/track?token=...`, decodes the H.264 relay via
 * H264Stream, runs js-aruco2 detection on each decoded frame (reusing
 * whichever dictionary useDroneSocket's markerPattern currently has
 * active), computes steering via pickTargetMarker + computeSteering, and
 * streams `rc` back at a fixed cadence -- entirely independent of, and
 * running ALONGSIDE, the existing cloud connection (see
 * local-track-protocol.md). No auto-reconnect (unlike useDroneSocket) --
 * deliberately simpler, since this channel is only ever a supplementary
 * low-latency data plane, never the sole link to the drone; a drop just
 * stops the local join, cloud commands still work.
 *
 * Mirrors useDroneSocket's hook shape: components read `state` and call
 * the exposed actions; none of them touch the WebSocket, decoder, or
 * detector directly.
 */
export function useLocalTrack({ markerPattern, isFlying }: UseLocalTrackOptions) {
  const [host, setHostState] = useState<string>(() => loadCookie(HOST_COOKIE) || DEFAULT_HOST);
  const [token, setTokenState] = useState<string>(() => loadCookie(TOKEN_COOKIE));
  const [active, setActiveState] = useState(false);
  const [connState, setConnState] = useState<LocalTrackConnState>("idle");
  const [telemetry, setTelemetry] = useState<LocalTrackTelemetry>(IDLE_TELEMETRY);

  const hostRef = useRef(host);
  hostRef.current = host;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const markerPatternRef = useRef(markerPattern);
  markerPatternRef.current = markerPattern;
  const isFlyingRef = useRef(isFlying);
  isFlyingRef.current = isFlying;

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<H264Stream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rcTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResultRef = useRef<SteeringResult | null>(null);
  const lastResultAtMsRef = useRef(0);

  /** Live decoded-frame subscribers (a visible <canvas> in the panel
   * copies from here). Ref-backed, not React state -- frames decode up to
   * ~30/sec, and routing that through setState would re-render every
   * consumer of this hook's whole state at that rate, mirroring
   * useDroneSocket's frameListenersRef for the identical reason. */
  const frameListenersRef = useRef<Set<(canvas: HTMLCanvasElement) => void>>(new Set());

  // Registers (or re-registers) the custom marker into THIS browser tab's
  // own js-aruco2 module instance as soon as it's set on the cloud
  // connection -- cheap, pure bookkeeping, mirrors server.ts's identical
  // "as soon as it's set" comment. Actually taking effect for detection
  // still requires the next start() (the detector's dictionary is frozen
  // for the session), same tradeoff the backend makes.
  useEffect(() => {
    if (markerPattern) registerCustomMarker(markerPattern, ARUCO_CUSTOM_TAU);
  }, [markerPattern]);

  const setHost = useCallback((h: string) => {
    hostRef.current = h;
    setHostState(h);
  }, []);

  const setToken = useCallback((t: string) => {
    tokenRef.current = t;
    setTokenState(t);
  }, []);

  const clearRcTimer = useCallback(() => {
    if (rcTimerRef.current) {
      clearInterval(rcTimerRef.current);
      rcTimerRef.current = null;
    }
  }, []);

  /** Tears down the WS/decoder/detector for one session. `sendFinalZero`
   * sends one last `rc 0 0 0 0` before closing, per
   * local-track-protocol.md -- the drone must never keep the last
   * commanded velocity after this channel stops, matching the cloud path's
   * stopTracking() contract in server.ts. */
  const teardown = useCallback(
    (sendFinalZero: boolean) => {
      clearRcTimer();
      const ws = wsRef.current;
      if (ws) {
        if (sendFinalZero && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "rc", ...ZERO_RC } satisfies LocalRc));
          } catch {
            /* ignore -- best-effort, matches the fire-and-forget rc semantics */
          }
        }
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      wsRef.current = null;
      streamRef.current?.close();
      streamRef.current = null;
      lastResultRef.current = null;
      setTelemetry(IDLE_TELEMETRY);
    },
    [clearRcTimer],
  );

  const startRcTimer = useCallback(() => {
    clearRcTimer();
    rcTimerRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const result = lastResultRef.current;
      const fresh = result != null && Date.now() - lastResultAtMsRef.current < STEERING_STALE_MS;
      // Never stream movement while the cloud connection doesn't believe
      // the drone is airborne -- see UseLocalTrackOptions.isFlying's doc.
      const grounded = isFlyingRef.current === false;
      const steer = fresh && !grounded ? result : null;
      const rc = steer?.rc ?? ZERO_RC;

      try {
        ws.send(JSON.stringify({ type: "rc", ...rc } satisfies LocalRc));
      } catch {
        /* ignore -- best-effort, matches the fire-and-forget rc semantics
         * local-track-protocol.md specifies */
      }

      setTelemetry({
        active: true,
        markerFound: steer?.markerFound ?? false,
        markerId: steer?.markerId,
        dx: steer?.dx ?? 0,
        dy: steer?.dy ?? 0,
        sizeRatio: steer?.sizeRatio,
        rc,
      });
    }, RC_SEND_INTERVAL_MS);
  }, [clearRcTimer]);

  const start = useCallback(() => {
    if (wsRef.current) return; // already connecting/connected -- idempotent, mirrors TrackingSession.start()
    const currentHost = hostRef.current.trim() || DEFAULT_HOST;
    const currentToken = tokenRef.current.trim();
    if (!currentToken) {
      setConnState("error");
      toast.error("로컬 추적 토큰을 입력하세요.");
      return;
    }
    saveCookie(HOST_COOKIE, currentHost);
    saveCookie(TOKEN_COOKIE, currentToken);

    // A web-drawn custom pattern overrides the statically configured
    // dictionary for this session, always id 0 (a custom dictionary holds
    // exactly one marker) -- identical logic to server.ts's
    // sessionSteeringConfig. Frozen for the session, same as the backend.
    const dictionaryName = markerPatternRef.current ? CUSTOM_MARKER_DICT_NAME : DEFAULT_ARUCO_DICTIONARY;
    const targetMarkerId = markerPatternRef.current ? 0 : undefined;
    const cfg: SteeringConfig = {
      frameWidth: VIDEO_WIDTH,
      frameHeight: VIDEO_HEIGHT,
      targetSizePx: ARUCO_TARGET_SIZE_PX,
      maxRc: TRACK_MAX_RC,
      yawGain: TRACK_YAW_GAIN,
      altGain: TRACK_ALT_GAIN,
      distGain: TRACK_DIST_GAIN,
      dictionaryName,
      targetMarkerId,
    };

    if (!canvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.width = VIDEO_WIDTH;
      canvas.height = VIDEO_HEIGHT;
      canvasRef.current = canvas;
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      setConnState("error");
      toast.error("캔버스 2D 컨텍스트를 생성할 수 없습니다.");
      return;
    }

    const detector: ArucoDetector = createArucoDetector(dictionaryName);
    detector.detectStreamInit(VIDEO_WIDTH, VIDEO_HEIGHT, (_image, markerList) => {
      const target = pickTargetMarker(markerList, targetMarkerId);
      lastResultRef.current = computeSteering(target?.corners ?? null, target?.id, cfg);
      lastResultAtMsRef.current = Date.now();
    });

    const stream = new H264Stream({
      onFrame: (frame) => {
        try {
          ctx.drawImage(frame, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
        } finally {
          frame.close();
        }
        try {
          const imageData = ctx.getImageData(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
          detector.detectStream(imageData.data);
        } catch {
          /* a torn/stalled frame here just means one missed detection --
           * not fatal, the next frame retries */
        }
        for (const cb of frameListenersRef.current) cb(canvas);
      },
      onError: (e) => toast.error(`영상 디코딩 오류: ${e.message}`),
    });
    streamRef.current = stream;

    setConnState("connecting");
    let ws: WebSocket;
    try {
      const url = `ws://${currentHost}:${LOCAL_TRACK_PORT}${LOCAL_TRACK_PATH}?token=${encodeURIComponent(currentToken)}`;
      ws = new WebSocket(url);
    } catch (e) {
      setConnState("error");
      toast.error(`연결 실패: ${e instanceof Error ? e.message : String(e)}`);
      teardown(false);
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnState("connected");
      startRcTimer();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) streamRef.current?.push(new Uint8Array(ev.data));
    };
    ws.onerror = () => {
      /* onclose follows; surface only there, matching useDroneSocket */
    };
    ws.onclose = () => {
      teardown(false); // socket is already gone -- nothing to send a final zero over
      setConnState("disconnected");
      setActiveState(false);
    };
  }, [startRcTimer, teardown]);

  const stop = useCallback(() => {
    teardown(true);
    setConnState("idle");
  }, [teardown]);

  const setActive = useCallback(
    (on: boolean) => {
      setActiveState(on);
      if (on) start();
      else stop();
    },
    [start, stop],
  );

  // Unmount: stop cleanly (final zero rc, close everything) rather than
  // leaving a dangling WS/decoder/timer behind.
  useEffect(() => {
    return () => {
      teardown(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Subscribes to live decoded video frames (each callback receives the
   * hook's internal canvas, already painted with the latest frame); returns
   * an unsubscribe function. See frameListenersRef above for why this
   * bypasses React state entirely -- mirrors useDroneSocket's onFrame. */
  const onFrame = useCallback((cb: (canvas: HTMLCanvasElement) => void) => {
    frameListenersRef.current.add(cb);
    return () => {
      frameListenersRef.current.delete(cb);
    };
  }, []);

  const state: LocalTrackState = {
    connState,
    connLabel: CONN_LABELS[connState],
    telemetry,
  };

  return { state, host, setHost, token, setToken, active, setActive, onFrame };
}

export type UseLocalTrack = ReturnType<typeof useLocalTrack>;
