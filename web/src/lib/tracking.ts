/**
 * Client-side MIRROR of the backend's `src/tracking.ts` pure steering/
 * detection math and custom-marker encoding -- verbatim logic, not just
 * similar, verified byte-identical to the backend via tracking.test.ts
 * (same cross-import verification style as markerSvg.ts's SVG-generation
 * mirror, one level up in rigor since this one is checked against the real
 * backend module at test time rather than just against the js-aruco2
 * library's own behavior).
 *
 * This exists because `useLocalTrack` runs ArUco detection directly in the
 * browser (see local-track-protocol.md) -- the low-latency local data plane
 * bypasses the backend entirely, so the safety-critical steering math has
 * to execute client-side too. Per this project's established convention
 * (see ws-protocol.ts's comment), TYPES could cross-import from `src/` for
 * free, but RUNTIME LOGIC that must execute in the browser cannot (the
 * backend module reaches for `Bun.spawn`/ffmpeg elsewhere in the same
 * file), so it's hand-mirrored here instead and pinned to the backend by a
 * test rather than the type system alone.
 *
 * Deliberately NOT mirrored: `splitJpegFrames`, `VideoPreviewSession`,
 * `TrackingSession` -- all backend-only (ffmpeg/Bun.Subprocess glue for the
 * cloud path's video pipeline). The local path decodes video itself via
 * WebCodecs (see h264decode.ts) and drives js-aruco2's streaming API
 * directly from useLocalTrack, using createArucoDetector() below.
 */

/** One detected ArUco marker, as returned by js-aruco2. Exported (unlike
 * the backend's copy, which only needs it within the same file) because
 * useLocalTrack consumes it directly from its own detectStreamInit callback. */
export interface ArucoMarker {
  id: number;
  corners: { x: number; y: number }[];
  hammingDistance: number;
}

/** Narrow surface of js-aruco2's `AR.Detector` this file actually uses.
 * Exported for the same reason as ArucoMarker above -- useLocalTrack holds
 * one of these across its session lifetime. */
export interface ArucoDetector {
  detectStreamInit(
    width: number,
    height: number,
    callback: (image: unknown, markerList: ArucoMarker[]) => void,
  ): void;
  detectStream(data: Uint8Array | Uint8ClampedArray): void;
}

interface ArucoDetectorCtor {
  new (config?: { dictionaryName?: string; maxHammingDistance?: number }): ArucoDetector;
}

/** One js-aruco2 dictionary definition, as assignable to `AR.DICTIONARIES`.
 * `codeList[i]` may be a number (parsed as binary via toString(2)), a hex
 * string, or an array of bytes -- see AR.Dictionary.prototype._initialize in
 * js-aruco2/src/aruco.js. This file only ever produces the `number` form. */
export interface ArucoDictionaryDef {
  nBits: number;
  tau: number;
  codeList: Array<number | string | number[]>;
}

// js-aruco2 ships no TypeScript declarations AND predates ESM/CJS-interop
// tooling entirely: it publishes itself via the legacy "attach to whatever
// `this` is" idiom -- `var AR = {}; this.AR = AR;` in aruco.js, `var CV =
// {}; this.CV = CV;` in its cv.js dependency (see js-aruco2/src/aruco.js /
// cv.js) -- designed for either a bare <script> tag (top-level `this` ==
// `window`) or Node's CJS module wrapper (top-level `this` ==
// `module.exports`). The backend (a real CJS/Bun runtime) can `import {
// AR } from "js-aruco2"` directly because Bun's dynamic CJS interop
// inspects the resulting module.exports object at RUNTIME. Vite/Rolldown's
// PRODUCTION BUNDLER instead does STATIC export analysis (needed for
// tree-shaking) and doesn't recognize the `this.X = X` idiom as an export
// at all -- neither a named `AR` import nor a plain default import
// resolves ("X is not exported"), regardless of any commonjsOptions.
//
// Fix: don't ask either bundler to parse js-aruco2 as a JS module at all.
// Load its two source files as PLAIN TEXT (Vite's/Bun's shared `?raw`
// suffix -- both verified to return the raw string, sidestepping module-
// format detection entirely) and evaluate them with `this` bound to a
// scope object under our control, in the same order a <script>-tag setup
// would load them (cv.js first, since aruco.js's own `this.CV ||
// require('./cv').CV` fallback only runs if CV isn't already present --
// which sidesteps needing a `require` shim too). Only cv.js + aruco.js are
// needed: the AR.Detector / AR.Dictionary / AR.DICTIONARIES surface this
// file uses never touches js-aruco2's separate pose-estimation modules
// (posit1/posit2/svd.js).
import cvSource from "js-aruco2/src/cv.js?raw";
import arucoSource from "js-aruco2/src/aruco.js?raw";

interface ArucoModuleScope {
  CV?: unknown;
  AR: { Detector: ArucoDetectorCtor; DICTIONARIES: Record<string, ArucoDictionaryDef> };
}
// `new Function(src)` bodies run in non-strict (sloppy) mode by default --
// unlike the surrounding ES module, which is always strict -- so `.call()`
// genuinely controls `this` inside them, matching what these scripts
// expect. Each gets its OWN function-scoped `var`/function declarations
// (no leakage into this module's scope); only writes visible are the
// explicit `this.CV = CV` / `this.AR = AR` assignments onto `scope`.
const arucoScope = {} as ArucoModuleScope;
new Function(cvSource).call(arucoScope);
new Function(arucoSource).call(arucoScope);
const AR = arucoScope.AR;

/** js-aruco2's own default dictionary, used whenever no custom marker is
 * registered. Mirrors config.arucoDictionary's default on the backend and
 * SteeringConfig.dictionaryName's documented fallback. */
export const DEFAULT_ARUCO_DICTIONARY = "ARUCO_MIP_36h12";

/**
 * Constructs a fresh js-aruco2 detector for one dictionary. On the backend
 * this is inlined directly into TrackingSession.start() (same file); it's
 * pulled out as its own export here purely because useLocalTrack (a
 * different file) needs to build one itself -- the construction line is
 * otherwise identical, same fallback default included.
 */
export function createArucoDetector(dictionaryName?: string): ArucoDetector {
  return new AR.Detector({ dictionaryName: dictionaryName ?? DEFAULT_ARUCO_DICTIONARY });
}

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

/**
 * Test-support accessor for the dictionary this module's OWN js-aruco2
 * instance has registered under `name` (e.g. to verify registerCustomMarker
 * actually took effect). Not used by any production code path --
 * useLocalTrack only ever needs createArucoDetector -- but this file's `AR`
 * is a genuinely SEPARATE, independent js-aruco2 instance from the
 * backend's (see the loading comment above: it's evaluated from raw source
 * text, not the shared "js-aruco2" package singleton Node/Bun's module
 * cache would otherwise provide), so tracking.test.ts can't inspect it via
 * a dynamic `import("js-aruco2")` the way it inspects the backend's.
 */
export function __getDictionaryForTest(name: string): ArucoDictionaryDef | undefined {
  return AR.DICTIONARIES[name];
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
