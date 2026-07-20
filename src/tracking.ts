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

/** One js-aruco2 dictionary definition, as assignable to `AR.DICTIONARIES`.
 * `codeList[i]` may be a number (parsed as binary via toString(2)), a hex
 * string, or an array of bytes -- see AR.Dictionary.prototype._initialize in
 * js-aruco2/src/aruco.js. This file only ever produces the `number` form. */
interface ArucoDictionaryDef {
  nBits: number;
  tau: number;
  codeList: Array<number | string | number[]>;
}

// js-aruco2 ships no TypeScript declarations (plain CJS, no @types package,
// and this task adds no separate .d.ts file) -- import untyped and narrow to
// the small surface above via a single cast, rather than augmenting the
// (nonexistent) module types, which tsc rejects for an untyped CJS module.
// @ts-expect-error -- untyped module, see comment above
import { AR as arucoRuntime } from "js-aruco2";
const AR = arucoRuntime as unknown as {
  Detector: ArucoDetectorCtor;
  DICTIONARIES: Record<string, ArucoDictionaryDef>;
};

// ---------- Custom (web-drawn) 4x4 marker ----------

/** Interior data cells for a 4x4 custom marker (16 bits total, matching the
 * classic ArUco 4x4 marker layout: a 1-cell black border around a 4x4 grid). */
export const CUSTOM_MARKER_BITS = 16;
export const CUSTOM_MARKER_GRID_SIZE = 4; // sqrt(CUSTOM_MARKER_BITS)

/** js-aruco2 dictionary name for the live, user-drawn custom marker.
 * Re-registered (overwritten in place) by registerCustomMarker() each time a
 * new pattern is applied; always holds exactly one marker, at id 0. */
export const CUSTOM_MARKER_DICT_NAME = "TELLOVOICE_CUSTOM";

/**
 * Encodes a 4x4 (16-cell) black/white pattern into the packed integer js-
 * aruco2's dictionary loader expects: MSB-first, row-major (pattern[0] = top-
 * left cell). `true` = white/"1" cell, `false` = black/"0" cell -- this
 * ordering is exactly what AR.Dictionary.prototype.generateSVG reads back
 * (see js-aruco2/src/aruco.js), so a pattern round-trips identically through
 * both "render it to print" (frontend) and "register it for detection"
 * (here) -- verified against the real library, including that all 4 camera
 * rotations of a printed marker still resolve to the same id.
 */
export function patternToCode(pattern: readonly boolean[]): number {
  if (pattern.length !== CUSTOM_MARKER_BITS) {
    throw new Error(`marker pattern must be exactly ${CUSTOM_MARKER_BITS} cells, got ${pattern.length}`);
  }
  let code = 0;
  for (const bit of pattern) code = (code << 1) | (bit ? 1 : 0);
  return code;
}

/**
 * Registers (or re-registers) a single-marker js-aruco2 dictionary for the
 * given pattern, so a subsequent `new AR.Detector({ dictionaryName:
 * CUSTOM_MARKER_DICT_NAME })` recognizes it at any of the 4 rotations (the
 * detector always tries all 4 -- see getMarker() in js-aruco2/src/aruco.js).
 *
 * `tau` is the max Hamming distance (out of 16 bits) still counted as a
 * match. Required explicitly: js-aruco2's own tau auto-derivation compares
 * every pair of codes in a dictionary, which degenerates to
 * Number.MAX_VALUE (matches anything) for a single-entry codeList like this
 * one, unlike the built-in multi-marker dictionaries.
 *
 * CRITICAL landmine in js-aruco2 itself, worked around here: its Dictionary
 * constructor does `this.tau = dictionary.tau || this._calculateTau()` --
 * `||` treats an explicit `tau: 0` as falsy, so it falls through to that
 * SAME Number.MAX_VALUE auto-derivation instead of the strict "exact match
 * only" the caller almost certainly meant. A tau of 0 would therefore
 * silently become "match literally anything" -- the opposite of what was
 * asked, and dangerous for a system that steers a physical drone off of it.
 * Clamped to a minimum of 1 to guarantee that can never happen; an exact
 * pixel-perfect match is unaffected either way (js-aruco2's find() checks
 * for one via a direct lookup BEFORE ever consulting tau).
 */
export function registerCustomMarker(pattern: readonly boolean[], tau: number): void {
  const code = patternToCode(pattern);
  AR.DICTIONARIES[CUSTOM_MARKER_DICT_NAME] = {
    nBits: CUSTOM_MARKER_BITS,
    tau: Math.max(1, tau),
    codeList: [code],
  };
}

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

// ---------- Live camera preview (independent of ArUco detection) ----------

/**
 * Incrementally splits a concatenated MJPEG byte stream (ffmpeg's `-f mjpeg`
 * output: back-to-back JPEG images, each starting with SOI 0xFFD8 and ending
 * with EOI 0xFFD9) into complete frames. Pure -- no I/O -- so it's
 * unit-testable with hand-built buffers, mirroring computeSteering /
 * pickTargetMarker above.
 *
 * `pending` is leftover bytes from a previous call (a partial trailing frame,
 * or a lone 0xFF that might be the first byte of a marker split across the
 * chunk boundary); `chunk` is the newly arrived bytes. Returns every complete
 * frame found (SOI..EOI inclusive, in arrival order) plus the new `rest` to
 * pass into the next call. Bytes before the first SOI are dropped silently
 * (stream garbage / mid-frame ffmpeg startup) rather than ever surfaced as a
 * "frame".
 */
export function splitJpegFrames(pending: Uint8Array, chunk: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  let buf: Uint8Array;
  if (pending.length === 0) buf = chunk;
  else {
    buf = new Uint8Array(pending.length + chunk.length);
    buf.set(pending, 0);
    buf.set(chunk, pending.length);
  }

  const frames: Uint8Array[] = [];
  let from = 0;
  while (true) {
    const soi = indexOfMarker(buf, 0xff, 0xd8, from);
    if (soi === -1) {
      // No full SOI in what's left. A trailing lone 0xFF could be the first
      // half of a marker split across this chunk boundary -- keep it.
      const rest = buf.length > 0 && buf[buf.length - 1] === 0xff ? buf.subarray(buf.length - 1) : new Uint8Array(0);
      return { frames, rest };
    }
    const eoi = indexOfMarker(buf, 0xff, 0xd9, soi + 2);
    if (eoi === -1) return { frames, rest: buf.subarray(soi) }; // incomplete tail frame -- wait for more
    frames.push(buf.slice(soi, eoi + 2)); // copy -- must outlive this buffer
    from = eoi + 2;
  }
}

function indexOfMarker(buf: Uint8Array, b0: number, b1: number, from: number): number {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1) return i;
  }
  return -1;
}

/** Preview encode configuration. Pure data, mirrors SteeringConfig's style. */
export interface PreviewConfig {
  /** Output width in px; height auto-scales (ffmpeg `scale=W:-2`) to
   * preserve the source aspect ratio, rounded to stay even as JPEG/YUV
   * encoding requires. */
  width: number;
  /** ffmpeg `-q:v` for the MJPEG output: 2 (best) .. 31 (worst). */
  quality: number;
  /** Upper bound on frames forwarded via onFrame per second, independent of
   * ffmpeg's actual decode rate -- so a fast decoder can't flood the link
   * to the browser. */
  maxFps: number;
}

/**
 * Manages one live JPEG-preview session: spawns its OWN ffmpeg process
 * (independent of TrackingSession's rawvideo/ArUco decode -- the same H.264
 * bytes are fed to both) that decodes the H.264 elementary stream and
 * re-encodes it as MJPEG, splits that into individual JPEG frames via
 * splitJpegFrames(), rate-limits to cfg.maxFps, and invokes onFrame per
 * frame. Purely a "camera view" for the UI -- entirely independent of (and
 * never blocks) the ArUco steering path. Never throws out of
 * start()/feedVideoChunk()/stop() -- catches and reports via onError.
 */
export class VideoPreviewSession {
  private readonly cfg: PreviewConfig;
  private readonly onFrame: (jpeg: Uint8Array) => void;
  private readonly onError: (e: Error) => void;

  private proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private started = false;
  private pending: Uint8Array = new Uint8Array(0);
  private lastEmitAtMs = 0;

  constructor(cfg: PreviewConfig, onFrame: (jpeg: Uint8Array) => void, onError?: (e: Error) => void) {
    this.cfg = cfg;
    this.onFrame = onFrame;
    this.onError = onError ?? (() => {});
  }

  /** Spawns ffmpeg. Idempotent -- calling start() while already started is a no-op. */
  start(): void {
    if (this.started) {
      console.log("[preview] start() called while already started -- ignoring");
      return;
    }
    try {
      const proc = Bun.spawn({
        cmd: [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          // ffmpeg's `-f h264` demuxer defaults to a 5,000,000-byte probe
          // before it commits to processing ANY input -- for a live,
          // continuously-fed pipe (never reaching that much data quickly,
          // and never hitting EOF until the session ends) this means ffmpeg
          // silently withholds ALL output until stdin closes. Verified
          // empirically (incl. against the real production Docker image):
          // shrinking the probe window cuts that stall from ~3s to ~1.2s,
          // after which frames flow continuously. See the same fix on
          // TrackingSession below -- it has the identical characteristic.
          "-probesize",
          "32768",
          "-analyzeduration",
          "0",
          "-f",
          "h264",
          "-i",
          "pipe:0",
          "-vf",
          `scale=${this.cfg.width}:-2`,
          "-f",
          "mjpeg",
          "-q:v",
          String(this.cfg.quality),
          "-an",
          "pipe:1",
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      this.proc = proc;
      this.pending = new Uint8Array(0);
      this.lastEmitAtMs = 0;
      this.started = true;
      this.pumpStdout(proc.stdout);

      proc.exited
        .then((code) => {
          if (this.started) {
            console.log(`[preview] ffmpeg exited unexpectedly (code ${code})`);
            this.stop();
          }
        })
        .catch((err) => this.reportError(err));
    } catch (err) {
      this.reportError(err);
      this.proc = null;
      this.started = false;
    }
  }

  private async pumpStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!this.started) break;
        if (!value) continue;
        const { frames, rest } = splitJpegFrames(this.pending, value);
        this.pending = rest;
        for (const frame of frames) this.maybeEmit(frame);
      }
    } catch (err) {
      if (this.started) this.reportError(err);
    } finally {
      reader.releaseLock();
    }
  }

  private maybeEmit(frame: Uint8Array): void {
    const minIntervalMs = this.cfg.maxFps > 0 ? 1000 / this.cfg.maxFps : 0;
    const now = Date.now();
    if (now - this.lastEmitAtMs < minIntervalMs) return; // over budget -- drop, never queue/replay stale frames
    this.lastEmitAtMs = now;
    try {
      this.onFrame(frame);
    } catch (err) {
      this.reportError(err);
    }
  }

  /** Raw bytes from the ESP32's UDP video relay -- write to ffmpeg's stdin.
   * No-op if not started. Never throws -- self-heals by tearing down the
   * wedged process; the next start() respawns fresh. */
  feedVideoChunk(chunk: Uint8Array): void {
    if (!this.started || !this.proc) return;
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") return;
    try {
      stdin.write(chunk);
      stdin.flush();
    } catch (err) {
      this.reportError(err);
      this.stop();
    }
  }

  /** Kills the ffmpeg subprocess. Idempotent -- safe to call multiple times
   * or when never started. */
  stop(): void {
    this.started = false;
    const proc = this.proc;
    this.proc = null;
    this.pending = new Uint8Array(0);
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
          // Same ffmpeg pipe-stalls-until-EOF characteristic as
          // VideoPreviewSession above -- see its comment for the full
          // explanation. Without this, marker tracking would never see a
          // decoded frame until the session stopped (streamoff), making
          // "tracking" mode a total no-op against a live feed.
          "-probesize",
          "32768",
          "-analyzeduration",
          "0",
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
