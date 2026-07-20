import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { BrowserToServer, DroneCommand, ServerToBrowser } from "@/lib/ws-protocol";
import { fmtCmd } from "@/lib/fmt";

const PING_MS = 10000;
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 15000;
const TOKEN_COOKIE = "tv_token";
const LOG_CAP = 200;

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

const CONN_LABELS: Record<ConnState, string> = {
  idle: "연결 안 됨",
  connecting: "연결 중\u2026",
  connected: "연결됨",
  reconnecting: "재연결 중\u2026",
  disconnected: "연결 끊김",
};

export type LogKind = "info" | "sent" | "ok" | "fail" | "err";

export interface LogEntry {
  id: number;
  ts: number;
  kind: LogKind;
  text: string;
}

export interface TrackingState {
  active: boolean;
  markerFound: boolean;
  markerId?: number;
  dx: number;
  dy: number;
  sizeRatio?: number;
}

const IDLE_TRACKING: TrackingState = { active: false, markerFound: false, dx: 0, dy: 0 };

export interface DroneSocketState {
  connState: ConnState;
  connLabel: string;
  deviceOnline: boolean;
  battery: number | null;
  tracking: TrackingState;
  log: LogEntry[];
  processing: boolean;
  lastTranscript: string | null;
  /** Has a WebSocket connection ever succeeded this session (see the field's
   * own comment above the useState for why "disconnected" alone isn't
   * enough to tell a bad token from a routine retry). */
  everConnected: boolean;
}

function tokenFromUrl(): string {
  try {
    const p = new URLSearchParams(window.location.search).get("token");
    return p ? p.trim() : "";
  } catch {
    return "";
  }
}

function loadTokenCookie(): string {
  try {
    const m = document.cookie.match(/(?:^|;\s*)tv_token=([^;]*)/);
    return m ? decodeURIComponent(m[1]).trim() : "";
  } catch {
    return "";
  }
}

function saveToken(t: string): void {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    // 1 year; Lax so it rides same-site navigations.
    document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(t)}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* ignore */
  }
}

function wsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/browser?token=${encodeURIComponent(token)}`;
}

let nextLogId = 1;

/**
 * Owns the entire browser<->backend WebSocket lifecycle: connect/reconnect
 * (exponential backoff 1s->15s, reset on manual reconnect/online/visible),
 * token persistence (URL param first-visit, cookie thereafter), 10s
 * keepalive ping, and dispatch of every ServerToBrowser message into reactive
 * state. Pure transport -- components read `state` and call the `send*`
 * actions; none of them touch the WebSocket directly.
 */
export function useDroneSocket() {
  const [token, setTokenState] = useState<string>(() => tokenFromUrl() || loadTokenCookie());
  const [connState, setConnState] = useState<ConnState>("idle");
  const [connLabel, setConnLabel] = useState<string>(CONN_LABELS.idle);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [battery, setBattery] = useState<number | null>(null);
  const [tracking, setTracking] = useState<TrackingState>(IDLE_TRACKING);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  // Has this session EVER seen a successful open? A bad token on the
  // BROWSER endpoint is rejected at the HTTP upgrade (401) before any
  // WebSocket handshake completes, so it closes with code 1006 (abnormal),
  // NOT 1008 -- unlike the device endpoint's post-upgrade hello-frame
  // rejection. That means "disconnected" alone can't distinguish "bad
  // token, will never work" from "one dropped frame, retrying fine" -- this
  // flag is what actually lets the UI know a fresh token has never worked.
  const [everConnected, setEverConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_MIN);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualCloseRef = useRef(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  /** Last-seen tracking active/markerFound, so the "tracking" handler can
   * log state TRANSITIONS (started/stopped, marker found/lost) instead of
   * spamming a line per frame -- tracking telemetry arrives many times a
   * second while active. */
  const prevTrackingRef = useRef<{ active: boolean; markerFound: boolean }>({
    active: false,
    markerFound: false,
  });

  /** Live camera preview frame subscribers. A plain ref-backed Set (not
   * React state) on purpose: "frame" messages arrive up to
   * VIDEO_PREVIEW_MAX_FPS times/sec, and routing that through setState would
   * re-render every consumer of this hook's whole `state` object at that
   * rate. Subscribers (see onFrame below) get called directly and update
   * the DOM imperatively (e.g. an <img> ref), never touching React state. */
  const frameListenersRef = useRef<Set<(jpegBase64: string) => void>>(new Set());

  const appendLog = useCallback((kind: LogKind, text: string) => {
    setLog((prev) => {
      const next = [...prev, { id: nextLogId++, ts: Date.now(), kind, text }];
      return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
    });
  }, []);

  const setConn = useCallback((state: ConnState, label?: string) => {
    setConnState(state);
    setConnLabel(label ?? CONN_LABELS[state]);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const stopPing = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const send = useCallback(
    (msg: BrowserToServer): boolean => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
          return true;
        } catch (e) {
          toast.error(`전송 실패: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      }
      toast.error("연결되지 않음 \u2014 먼저 연결을 누르세요.");
      return false;
    },
    [],
  );

  const startPing = useCallback(() => {
    stopPing();
    pingTimerRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" } satisfies BrowserToServer));
        } catch {
          /* ignore */
        }
      }
    }, PING_MS);
  }, [stopPing]);

  const handleMessage = useCallback(
    (raw: string) => {
      let msg: ServerToBrowser;
      try {
        msg = JSON.parse(raw) as ServerToBrowser;
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "transcript":
          setLastTranscript(msg.text ?? "");
          appendLog("info", `인식: \u201c${String(msg.text ?? "")}\u201d`);
          return;

        case "parsed":
          setProcessing(false);
          appendLog("sent", `${msg.raw ?? ""}  \u2192  ${fmtCmd(msg.command)}`);
          return;

        case "tello":
          appendLog(msg.ok ? "ok" : "fail", `${fmtCmd(msg.command)} \u2192 ${msg.response ?? ""}`);
          return;

        case "status":
          setDeviceOnline(!!msg.deviceOnline);
          setBattery(typeof msg.battery === "number" ? msg.battery : null);
          return;

        case "tracking": {
          const active = !!msg.active;
          const markerFound = !!msg.markerFound;
          const prev = prevTrackingRef.current;

          if (active !== prev.active) {
            appendLog("info", active ? "마커 추적 시작됨" : "마커 추적 중지됨");
          } else if (active && markerFound !== prev.markerFound) {
            appendLog(
              markerFound ? "ok" : "info",
              markerFound
                ? `마커 발견${typeof msg.markerId === "number" ? ` (ID: ${msg.markerId})` : ""}`
                : "마커 놓침",
            );
          }
          prevTrackingRef.current = { active, markerFound };

          setTracking({
            active,
            markerFound,
            markerId: msg.markerId,
            dx: msg.dx ?? 0,
            dy: msg.dy ?? 0,
            sizeRatio: msg.sizeRatio,
          });
          return;
        }

        case "frame":
          for (const cb of frameListenersRef.current) cb(msg.jpeg);
          return;

        case "error":
          setProcessing(false);
          appendLog("err", `오류: ${String(msg.message ?? "")}`);
          toast.error(String(msg.message ?? "오류"));
          return;

        case "pong":
          return;
      }
    },
    [appendLog],
  );

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer();
    const secs = Math.round(reconnectDelayRef.current / 1000);
    setConn("reconnecting", `재연결 중 ${secs}초\u2026`);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!manualCloseRef.current) connect();
    }, reconnectDelayRef.current);
    reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, RECONNECT_MAX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearReconnectTimer, setConn]);

  const connect = useCallback(() => {
    clearReconnectTimer();
    const currentToken = tokenRef.current.trim();
    if (!currentToken) {
      setConn("disconnected", "토큰을 입력하세요");
      return;
    }

    const existing = wsRef.current;
    if (existing) {
      try {
        existing.onclose = null;
        existing.onerror = null;
        existing.onmessage = null;
        existing.onopen = null;
        existing.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
    stopPing();

    manualCloseRef.current = false;
    setConn("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(currentToken));
    } catch (e) {
      appendLog("err", `연결 실패: ${e instanceof Error ? e.message : String(e)}`);
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = RECONNECT_MIN;
      setConn("connected");
      setEverConnected(true);
      appendLog("info", "백엔드에 연결됨");
      saveToken(tokenRef.current.trim()); // remember a working token for next visit
      startPing();
    };
    ws.onmessage = (ev) => handleMessage(ev.data);
    ws.onerror = () => {
      /* onclose follows; surface only there */
    };
    ws.onclose = (ev) => {
      stopPing();
      if (manualCloseRef.current) {
        setConn("disconnected", "연결 끊김");
        return;
      }
      // 1008 (policy) from the server most likely means a bad token.
      if (ev && ev.code === 1008) {
        setConn("disconnected", "인증 거부됨");
        toast.error("연결이 거부되었습니다 \u2014 토큰을 확인하세요.");
        return; // do not hammer with a bad token
      }
      setConn("disconnected", "연결 끊김");
      scheduleReconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendLog, clearReconnectTimer, handleMessage, scheduleReconnect, setConn, startPing, stopPing]);

  const reconnectNow = useCallback(() => {
    reconnectDelayRef.current = RECONNECT_MIN;
    connect();
  }, [connect]);

  // Updates tokenRef synchronously (not just via the render-body assignment
  // above) so a caller that does setToken(x) immediately followed by
  // connect() -- e.g. the connect dialog's submit -- reads the NEW token,
  // not a stale one from before this render's state update lands.
  const setToken = useCallback((t: string) => {
    tokenRef.current = t;
    setTokenState(t);
  }, []);

  // Auto-connect on mount if we already have a token (URL param / cookie).
  useEffect(() => {
    if (tokenRef.current.trim()) connect();
    return () => {
      manualCloseRef.current = true;
      clearReconnectTimer();
      stopPing();
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect promptly when the tab regains focus / network returns.
  useEffect(() => {
    const onOnline = () => {
      if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) reconnectNow();
    };
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) &&
        tokenRef.current.trim()
      ) {
        reconnectNow();
      }
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reconnectNow]);

  const sendCommand = useCallback(
    (command: DroneCommand) => {
      if (send({ type: "command", command })) {
        appendLog("sent", `\u2192 ${fmtCmd(command)}`);
      }
    },
    [send, appendLog],
  );

  const sendAudio = useCallback(
    (audioBase64: string, mime: string) => {
      if (send({ type: "audio", mime, audio: audioBase64 })) {
        setProcessing(true);
      }
    },
    [send],
  );

  const setTrack = useCallback(
    (on: boolean) => {
      if (send({ type: "track", on })) {
        appendLog("sent", `\u2192 마커 추적 ${on ? "시작" : "중지"}`);
      }
    },
    [send, appendLog],
  );

  /** Subscribes to live camera preview frames (base64 JPEG, no `data:`
   * prefix); returns an unsubscribe function. See frameListenersRef above
   * for why this bypasses React state entirely. */
  const onFrame = useCallback((cb: (jpegBase64: string) => void) => {
    frameListenersRef.current.add(cb);
    return () => {
      frameListenersRef.current.delete(cb);
    };
  }, []);

  const state: DroneSocketState = {
    connState,
    connLabel,
    deviceOnline,
    battery,
    tracking,
    log,
    processing,
    lastTranscript,
    everConnected,
  };

  return { state, token, setToken, connect: reconnectNow, sendCommand, sendAudio, setTrack, onFrame };
}

export type UseDroneSocket = ReturnType<typeof useDroneSocket>;
