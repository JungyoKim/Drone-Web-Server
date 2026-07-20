/**
 * Wire protocol shared by backend, browser web app, and ESP32 firmware.
 *
 * Two WebSocket endpoints on the backend:
 *   /ws/browser  — phone browser  <-> backend   (audio in, feedback out)
 *   /ws/device   — ESP32          <-> backend   (commands out, Tello responses in)
 *
 * The ESP32 dials OUTBOUND to the backend (it sits behind the phone hotspot NAT,
 * so the backend can never connect to it first). The backend pushes commands down
 * that persistent socket. Keepalive and the physical emergency button are handled
 * autonomously on the ESP32 so drone safety never depends on the internet link.
 */

// ---------- Drone command vocabulary (backend -> device) ----------

/** Canonical high-level actions the AI maps user speech onto. */
export type DroneAction =
  | "takeoff"
  | "land"
  | "emergency"
  | "up"
  | "down"
  | "left"
  | "right"
  | "forward"
  | "back"
  | "cw"
  | "ccw"
  | "flip"
  | "battery"
  /** Enable/disable Tello's own video stream (UDP 11111). No args. */
  | "streamon"
  | "streamoff";

/** A validated, structured command. `arg` meaning depends on action. */
export interface DroneCommand {
  action: DroneAction;
  /** cm for moves (20-500), degrees for rotation (1-360). Omitted otherwise. */
  distance?: number;
  degree?: number;
  /** flip direction: l/r/f/b */
  dir?: "l" | "r" | "f" | "b";
}

// ---------- Browser <-> backend ----------

export type BrowserToServer =
  /** Recorded speech clip for STT + intent parsing. audio is base64, no data: prefix. */
  | { type: "audio"; mime: string; audio: string }
  /** Direct button press bypassing voice (e.g. UI land). */
  | { type: "command"; command: DroneCommand }
  /** Start/stop ArUco-marker-follow mode (drives streamon/off + a continuous rc loop). */
  | { type: "track"; on: boolean }
  /** Liveness. */
  | { type: "ping" };

export type ServerToBrowser =
  /** STT result echoed for UI. */
  | { type: "transcript"; text: string }
  /** Structured command the AI produced (for UI display + confirmation). */
  | { type: "parsed"; command: DroneCommand; raw: string }
  /** Tello's reply relayed up from the device (ok / error / telemetry value). */
  | { type: "tello"; command: DroneCommand; response: string; ok: boolean }
  /** Device connectivity + battery for the UI header. */
  | { type: "status"; deviceOnline: boolean; battery: number | null }
  /** ArUco tracking telemetry, broadcast a few times a second while active. */
  | { type: "tracking"; active: boolean; markerFound: boolean; markerId?: number; dx?: number; dy?: number; sizeRatio?: number; rc?: { a: number; b: number; c: number; d: number } }
  /** Recoverable error surfaced to the user. */
  | { type: "error"; message: string }
  | { type: "pong" };

// ---------- Device (ESP32) <-> backend ----------

export type DeviceToServer =
  /** First frame after connect; authenticates the device. */
  | { type: "hello"; deviceId: string; token: string; fw: string }
  /** Reply to a dispatched command, correlated by id. */
  | { type: "result"; id: number; response: string; ok: boolean }
  /** Unsolicited telemetry (battery poll, discovery, button press). */
  | { type: "telemetry"; battery?: number; telloIp?: string }
  /** Local event the backend should log/surface (e.g. hardware emergency). */
  | { type: "event"; event: "emergency_button" | "tello_found" | "tello_lost"; detail?: string }
  | { type: "pong" };

export type ServerToDevice =
  /** Auth outcome. */
  | { type: "welcome"; ok: boolean; message?: string }
  /** Dispatch a raw Tello SDK string. id correlates the eventual result. */
  | { type: "command"; id: number; tello: string; meta: DroneCommand }
  /** Continuous joystick-style control for tracking mode. Fire-and-forget --
   * Tello does NOT reply "ok" to `rc`, so this never touches the pending map.
   * Each channel is -100..100 (RC.min/RC.max); send `rc 0 0 0 0` to stop. */
  | { type: "rc"; a: number; b: number; c: number; d: number }
  | { type: "ping" };

// ---------- Limits (single source of truth; mirrored in firmware) ----------

export const LIMITS = {
  distanceCm: { min: 20, max: 500 },
  degree: { min: 1, max: 360 },
  /** Idle keepalive interval the ESP32 uses to dodge the 15s auto-land. */
  keepaliveMs: 5000,
} as const;

/** `rc a b c d` channel range (roll/pitch/throttle/yaw), per the Tello SDK. */
export const RC = { min: -100, max: 100 } as const;
