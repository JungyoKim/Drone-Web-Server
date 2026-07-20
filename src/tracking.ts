/** One detected ArUco marker, as returned by js-aruco2. */
export interface ArucoMarker {
  id: number;
  corners: { x: number; y: number }[];
  hammingDistance: number;
}

/** Narrow surface of js-aruco2's `AR.Detector` this file actually uses. */
interface ArucoDetector {
  detectStreamInit(
    width: number,
    height: number,
    callback: (image: unknown, markerList: ArucoMarker[]) => void,
  ): void;
  detectStream(data: Uint8Array): void;
}

interface ArucoDetectorCtor {
  new (config?: { dictionaryName?: string; maxHammingDistance?: number }): ArucoDetector;
}

// js-aruco2 ships no TypeScript declarations (plain CJS, no @types package,
// and this task adds no separate .d.ts file) -- import untyped and narrow to
// the small surface above via a single cast, rather than augmenting the
// (nonexistent) module types, which tsc rejects for an untyped CJS module.
// @ts-expect-error -- untyped module, see comment above
import { AR as arucoRuntime } from "js-aruco2";
const AR = arucoRuntime as unknown as { Detector: ArucoDetectorCtor };

/** Steering output for one processed video frame. */
export interface SteeringResult {
  markerFound: boolean;
  markerId?: number;
  /** Marker center X offset from frame center, normalized: (centerX - frameW/2) / (frameW/2). */
  dx: number;
  /** Marker center Y offset from frame center, normalized: (centerY - frameH/2) / (frameH/2). */
  dy: number;
  /** observed apparent size / cfg.targetSizePx. Only set when markerFound. */
  sizeRatio?: number;
  /** Tello rc channels, integers, clamped to [-cfg.maxRc, cfg.maxRc]. All 0 when !markerFound. */
  rc: { a: number; b: number; c: number; d: number };
}

/** Steering + detection configuration. Pure data — no I/O. */
export interface SteeringConfig {
  frameWidth: number;
  frameHeight: number;
  /** If set, only this marker id is considered. */
  targetMarkerId?: number;
  /** Desired apparent marker size (px) = desired follow distance. */
  targetSizePx: number;
  /** Clamp magnitude, applied AFTER gains. */
  maxRc: number;
  /** Multiplies dx -> d (yaw) channel. */
  yawGain: number;
  /** Multiplies dy -> c (throttle) channel. */
  altGain: number;
  /** Multiplies (sizeRatio - 1) -> b (pitch) channel. */
  distGain: number;
  /**
   * ArUco dictionary name (see js-aruco2). Optional here rather than a separate
   * TrackingSession constructor param -- it's detection config, so it belongs
   * next to the rest of the detector setup. Defaults to "ARUCO_MIP_36h12"
   * (js-aruco2's own default, mirroring config.arucoDictionary) when omitted.
   */
  dictionaryName?: string;
}

function clampToMaxRc(v: number, max: number): number {
  // `|| 0` folds -0 into +0 (Math.round(-0) and clamp can both yield -0,
  // which is numerically identical but a distinct value under Object.is --
  // callers/tests comparing rc fields should never see that distinction).
  return Math.max(-max, Math.min(max, v)) || 0;
}

/**
 * Picks which marker to track from a detected list: filters to
 * cfg.targetMarkerId if set, else considers all; among candidates picks the
 * one with the LARGEST apparent size (perimeter/4) -- most reliable
 * detection, also closest = most relevant to follow. Returns null if no
 * candidate.
 */
export function pickTargetMarker(
  markers: { id: number; corners: { x: number; y: number }[] }[],
  targetMarkerId: number | undefined,
): { id: number; corners: { x: number; y: number }[] } | null {
  const candidates = targetMarkerId != null ? markers.filter((m) => m.id === targetMarkerId) : markers;
  if (candidates.length === 0) return null;

  let best: { id: number; corners: { x: number; y: number }[] } | null = null;
  let bestSize = -Infinity;
  for (const m of candidates) {
    const size = apparentSize(m.corners);
    if (size > bestSize) {
      bestSize = size;
      best = m;
    }
  }
  return best;
}

function dist(p: { x: number; y: number }, q: { x: number; y: number }): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** Average of the 4 consecutive pairwise edge distances, treating corners as a cycle. */
function apparentSize(corners: { x: number; y: number }[]): number {
  const c0 = corners[0]!;
  const c1 = corners[1]!;
  const c2 = corners[2]!;
  const c3 = corners[3]!;
  return (dist(c0, c1) + dist(c1, c2) + dist(c2, c3) + dist(c3, c0)) / 4;
}

/**
 * Pure function, no I/O -- the safety-critical steering math. `corners` is
 * one detected marker's 4 {x,y} points in unspecified order (center = their
 * average; apparent size = average of the 4 consecutive pairwise edge
 * distances -- order-agnostic, works for any winding). Pass `corners: null`
 * when no marker was found (or none matched targetMarkerId).
 */
export function computeSteering(
  corners: { x: number; y: number }[] | null,
  markerId: number | undefined,
  cfg: SteeringConfig,
): SteeringResult {
  if (corners == null) {
    return { markerFound: false, dx: 0, dy: 0, rc: { a: 0, b: 0, c: 0, d: 0 } };
  }

  const centerX = corners.reduce((sum, p) => sum + p.x, 0) / corners.length;
  const centerY = corners.reduce((sum, p) => sum + p.y, 0) / corners.length;

  const dx = (centerX - cfg.frameWidth / 2) / (cfg.frameWidth / 2);
  const dy = (centerY - cfg.frameHeight / 2) / (cfg.frameHeight / 2);

  const size = apparentSize(corners);
  const sizeRatio = size / cfg.targetSizePx;

  const d = clampToMaxRc(Math.round(cfg.yawGain * dx), cfg.maxRc);
  const c = clampToMaxRc(Math.round(-cfg.altGain * dy), cfg.maxRc);
  const b = clampToMaxRc(Math.round(-cfg.distGain * (sizeRatio - 1)), cfg.maxRc);
  const a = 0; // v1: no lateral strafing -- yaw alone re-centers horizontally, keeping roll at
  // 0 avoids uncommanded sideways drift. Deliberate, do not add roll logic here.

  return { markerFound: true, markerId, dx, dy, sizeRatio, rc: { a, b, c, d } };
}

/**
 * Manages one live tracking session end to end: spawns ffmpeg to decode a raw
 * H.264 Annex-B elementary stream fed incrementally via feedVideoChunk(), runs
 * ArUco detection on each decoded frame via js-aruco2's streaming API,
 * computes steering via pickTargetMarker + computeSteering, and invokes
 * onSteering for every processed frame. Never throws out of
 * start()/feedVideoChunk()/stop() -- catches and reports via onError.
 */
export class TrackingSession {
  private readonly cfg: SteeringConfig;
  private readonly onSteering: (r: SteeringResult) => void;
  private readonly onError: (e: Error) => void;

  private proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private detector: ArucoDetector | null = null;
  private started = false;

  constructor(cfg: SteeringConfig, onSteering: (r: SteeringResult) => void, onError?: (e: Error) => void) {
    this.cfg = cfg;
    this.onSteering = onSteering;
    this.onError = onError ?? (() => {});
  }

  /**
   * Spawns ffmpeg and wires a js-aruco2 AR.Detector via detectStreamInit.
   * Idempotent -- calling start() while already started is a no-op.
   */
  start(): void {
    if (this.started) {
      console.log("[tracking] start() called while already started -- ignoring");
      return;
    }
    try {
      const proc = Bun.spawn({
        cmd: [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "h264",
          "-i",
          "pipe:0",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "-s",
          `${this.cfg.frameWidth}x${this.cfg.frameHeight}`,
          "-an",
          "pipe:1",
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      this.proc = proc;

      const detector = new AR.Detector({ dictionaryName: this.cfg.dictionaryName ?? "ARUCO_MIP_36h12" });
      detector.detectStreamInit(this.cfg.frameWidth, this.cfg.frameHeight, (_image, markerList) => {
        try {
          const target = pickTargetMarker(markerList, this.cfg.targetMarkerId);
          const steering = computeSteering(target?.corners ?? null, target?.id, this.cfg);
          this.onSteering(steering);
        } catch (err) {
          this.reportError(err);
        }
      });
      this.detector = detector;

      this.started = true;
      this.pumpStdout(proc.stdout);

      proc.exited
        .then((code) => {
          if (this.started) {
            console.log(`[tracking] ffmpeg exited unexpectedly (code ${code})`);
            this.stop();
          }
        })
        .catch((err) => this.reportError(err));
    } catch (err) {
      this.reportError(err);
      this.proc = null;
      this.detector = null;
      this.started = false;
    }
  }

  private async pumpStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!this.started || !this.detector) break;
        if (!value) continue;
        try {
          this.detector.detectStream(value);
        } catch (err) {
          this.reportError(err);
        }
      }
    } catch (err) {
      // Stream error (e.g. ffmpeg killed mid-read) -- not fatal to the caller.
      if (this.started) this.reportError(err);
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Raw bytes arriving from the ESP32's UDP video relay -- write to ffmpeg's
   * stdin. No-op (silently drop) if not started. Never throws -- catches
   * write errors, reports via onError, and self-heals by respawning ffmpeg on
   * the next start() rather than leaving a wedged process.
   */
  feedVideoChunk(chunk: Uint8Array): void {
    if (!this.started || !this.proc) return;
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") return;
    try {
      stdin.write(chunk);
      stdin.flush();
    } catch (err) {
      this.reportError(err);
      // Self-heal: tear down the wedged process; next start() respawns fresh.
      this.stop();
    }
  }

  /**
   * Kills the ffmpeg subprocess and releases the detector. Idempotent -- safe
   * to call multiple times or when never started.
   */
  stop(): void {
    this.started = false;
    const proc = this.proc;
    this.proc = null;
    this.detector = null;
    if (proc) {
      try {
        proc.kill();
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  private reportError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    try {
      this.onError(e);
    } catch {
      // onError itself must never propagate -- swallow.
    }
  }
}
