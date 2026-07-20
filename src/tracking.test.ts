import { test, expect, describe } from "bun:test";
import {
  computeSteering,
  pickTargetMarker,
  splitJpegFrames,
  patternToCode,
  registerCustomMarker,
  CUSTOM_MARKER_DICT_NAME,
  CUSTOM_MARKER_BITS,
  type SteeringConfig,
} from "./tracking.ts";

/**
 * Unit tests for the pure, safety-critical steering math in tracking.ts.
 * `computeSteering` and `pickTargetMarker` take no I/O -- no ffmpeg, no UDP,
 * no js-aruco2 detector -- so they're driven directly with hand-built corner
 * arrays, matching the style of sequence.test.ts (hand-written fakes, no
 * mocking framework, behavior-focused assertions).
 */

const baseCfg: SteeringConfig = {
  frameWidth: 960,
  frameHeight: 720,
  targetSizePx: 100,
  maxRc: 35,
  yawGain: 60,
  altGain: 60,
  distGain: 80,
};

/** Axis-aligned square corners (in arbitrary winding order) centered at (cx, cy), side 2*halfSize. */
function square(cx: number, cy: number, halfSize: number): { x: number; y: number }[] {
  return [
    { x: cx - halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy + halfSize },
    { x: cx - halfSize, y: cy + halfSize },
  ];
}

describe("computeSteering", () => {
  test("no marker -> markerFound false, all-zero rc, no id/sizeRatio", () => {
    const result = computeSteering(null, undefined, baseCfg);
    expect(result.markerFound).toBe(false);
    expect(result.markerId).toBeUndefined();
    expect(result.sizeRatio).toBeUndefined();
    expect(result.dx).toBe(0);
    expect(result.dy).toBe(0);
    expect(result.rc).toEqual({ a: 0, b: 0, c: 0, d: 0 });
  });

  test("marker exactly centered at target size -> dx/dy 0, rc all 0", () => {
    // side 2*50 = 100 = targetSizePx -> sizeRatio === 1
    const corners = square(baseCfg.frameWidth / 2, baseCfg.frameHeight / 2, 50);
    const result = computeSteering(corners, 7, baseCfg);
    expect(result.markerFound).toBe(true);
    expect(result.markerId).toBe(7);
    expect(result.dx).toBeCloseTo(0, 9);
    expect(result.dy).toBeCloseTo(0, 9);
    expect(result.sizeRatio).toBeCloseTo(1, 9);
    expect(result.rc).toEqual({ a: 0, b: 0, c: 0, d: 0 });
  });

  test("marker off-center to the right -> dx>0, d = round(yawGain*dx) (positive)", () => {
    const cx = baseCfg.frameWidth / 2 + 200;
    const cy = baseCfg.frameHeight / 2;
    const corners = square(cx, cy, 50);
    const result = computeSteering(corners, 1, baseCfg);
    const expectedDx = (cx - baseCfg.frameWidth / 2) / (baseCfg.frameWidth / 2);
    expect(result.dx).toBeCloseTo(expectedDx, 9);
    expect(result.dx).toBeGreaterThan(0);
    expect(result.rc.d).toBe(Math.round(baseCfg.yawGain * expectedDx));
    expect(result.rc.d).toBeGreaterThan(0);
  });

  test("marker off-center to the left -> dx<0, d negative", () => {
    const cx = baseCfg.frameWidth / 2 - 200;
    const cy = baseCfg.frameHeight / 2;
    const corners = square(cx, cy, 50);
    const result = computeSteering(corners, 1, baseCfg);
    expect(result.dx).toBeLessThan(0);
    expect(result.rc.d).toBeLessThan(0);
  });

  test("marker below center -> dy>0, c negative (move up to re-center)", () => {
    const cx = baseCfg.frameWidth / 2;
    const cy = baseCfg.frameHeight / 2 + 200;
    const corners = square(cx, cy, 50);
    const result = computeSteering(corners, 1, baseCfg);
    const expectedDy = (cy - baseCfg.frameHeight / 2) / (baseCfg.frameHeight / 2);
    expect(result.dy).toBeCloseTo(expectedDy, 9);
    expect(result.dy).toBeGreaterThan(0);
    expect(result.rc.c).toBe(Math.round(-baseCfg.altGain * expectedDy));
    expect(result.rc.c).toBeLessThan(0);
  });

  test("marker above center -> dy<0, c positive (move down to re-center)", () => {
    const cx = baseCfg.frameWidth / 2;
    const cy = baseCfg.frameHeight / 2 - 200;
    const corners = square(cx, cy, 50);
    const result = computeSteering(corners, 1, baseCfg);
    expect(result.dy).toBeLessThan(0);
    expect(result.rc.c).toBeGreaterThan(0);
  });

  test("marker too close (sizeRatio > 1) -> b negative (move back)", () => {
    // side 2*100 = 200, targetSizePx 100 -> sizeRatio 2. maxRc raised so the
    // raw formula is asserted directly, without the clamp (covered separately below).
    const roomyCfg: SteeringConfig = { ...baseCfg, maxRc: 1000 };
    const corners = square(roomyCfg.frameWidth / 2, roomyCfg.frameHeight / 2, 100);
    const result = computeSteering(corners, 1, roomyCfg);
    expect(result.sizeRatio).toBeCloseTo(2, 9);
    expect(result.rc.b).toBeLessThan(0);
    expect(result.rc.b).toBe(Math.round(-roomyCfg.distGain * (result.sizeRatio! - 1)));
  });

  test("marker too far (sizeRatio < 1) -> b positive (move forward)", () => {
    // side 2*25 = 50, targetSizePx 100 -> sizeRatio 0.5
    const corners = square(baseCfg.frameWidth / 2, baseCfg.frameHeight / 2, 25);
    const result = computeSteering(corners, 1, baseCfg);
    expect(result.sizeRatio).toBeCloseTo(0.5, 9);
    expect(result.rc.b).toBeGreaterThan(0);
  });

  test("rc channels are clamped to exactly +-maxRc when the raw value overshoots", () => {
    // Huge gains push every channel's raw magnitude far past maxRc; the clamp
    // must land exactly on the boundary, not merely "somewhere smaller".
    const hotCfg: SteeringConfig = { ...baseCfg, yawGain: 10000, altGain: 10000, distGain: 10000 };
    const cx = baseCfg.frameWidth / 2 + 200; // dx > 0 -> raw d far > maxRc
    const cy = baseCfg.frameHeight / 2 + 200; // dy > 0 -> raw c far < -maxRc
    const corners = square(cx, cy, 200); // sizeRatio far > 1 -> raw b far < -maxRc
    const result = computeSteering(corners, 1, hotCfg);
    expect(result.rc.d).toBe(hotCfg.maxRc);
    expect(result.rc.c).toBe(-hotCfg.maxRc);
    expect(result.rc.b).toBe(-hotCfg.maxRc);

    // And the opposite-sign case clamps to the negative boundary for d.
    const leftCorners = square(baseCfg.frameWidth / 2 - 200, baseCfg.frameHeight / 2, 50);
    const leftResult = computeSteering(leftCorners, 1, hotCfg);
    expect(leftResult.rc.d).toBe(-hotCfg.maxRc);
  });

  test("rc.a is always 0, regardless of inputs (deliberate v1 no-strafe choice)", () => {
    expect(computeSteering(null, undefined, baseCfg).rc.a).toBe(0);
    expect(computeSteering(square(480, 360, 50), 1, baseCfg).rc.a).toBe(0);
    expect(computeSteering(square(900, 700, 300), 2, baseCfg).rc.a).toBe(0);
    expect(computeSteering(square(10, 10, 5), 3, { ...baseCfg, yawGain: 99999, altGain: 99999 }).rc.a).toBe(0);
  });
});

describe("pickTargetMarker", () => {
  test("targetMarkerId set -> filters to matching id, ignoring others", () => {
    const markers = [
      { id: 1, corners: square(100, 100, 10) },
      { id: 2, corners: square(200, 200, 50) },
      { id: 3, corners: square(300, 300, 5) },
    ];
    const picked = pickTargetMarker(markers, 2);
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe(2);
  });

  test("targetMarkerId set but no marker matches -> null", () => {
    const markers = [
      { id: 1, corners: square(100, 100, 10) },
      { id: 3, corners: square(300, 300, 5) },
    ];
    expect(pickTargetMarker(markers, 99)).toBeNull();
  });

  test("empty marker list -> null regardless of targetMarkerId", () => {
    expect(pickTargetMarker([], undefined)).toBeNull();
    expect(pickTargetMarker([], 5)).toBeNull();
  });

  test("targetMarkerId unset -> picks the largest apparent-size candidate", () => {
    const small = { id: 1, corners: square(100, 100, 10) }; // side 20
    const large = { id: 2, corners: square(200, 200, 80) }; // side 160
    const medium = { id: 3, corners: square(300, 300, 40) }; // side 80
    const picked = pickTargetMarker([small, large, medium], undefined);
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe(2);
  });
});

/**
 * Unit tests for the pure MJPEG frame-splitter that feeds the live camera
 * preview (VideoPreviewSession). No ffmpeg/UDP/subprocess involved -- just
 * hand-built byte buffers, matching this file's existing style.
 */
describe("splitJpegFrames", () => {
  function jpeg(payload: number[] = [1, 2, 3]): number[] {
    return [0xff, 0xd8, ...payload, 0xff, 0xd9];
  }

  test("single complete frame in one chunk -> one frame, empty rest", () => {
    const chunk = new Uint8Array(jpeg([1, 2, 3]));
    const { frames, rest } = splitJpegFrames(new Uint8Array(0), chunk);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!)).toEqual(Array.from(chunk));
    expect(rest.length).toBe(0);
  });

  test("multiple complete frames in one chunk -> all returned in order", () => {
    const f1 = jpeg([1]);
    const f2 = jpeg([2, 2]);
    const f3 = jpeg([3, 3, 3]);
    const chunk = new Uint8Array([...f1, ...f2, ...f3]);
    const { frames, rest } = splitJpegFrames(new Uint8Array(0), chunk);
    expect(frames.length).toBe(3);
    expect(Array.from(frames[0]!)).toEqual(f1);
    expect(Array.from(frames[1]!)).toEqual(f2);
    expect(Array.from(frames[2]!)).toEqual(f3);
    expect(rest.length).toBe(0);
  });

  test("frame split across two chunks -> first call withholds it, second call completes it", () => {
    const full = jpeg([9, 9, 9, 9]);
    const chunk1 = new Uint8Array(full.slice(0, 4)); // SOI + partial payload, no EOI yet
    const chunk2 = new Uint8Array(full.slice(4)); // rest of payload + EOI

    const first = splitJpegFrames(new Uint8Array(0), chunk1);
    expect(first.frames.length).toBe(0);
    expect(Array.from(first.rest)).toEqual(Array.from(chunk1));

    const second = splitJpegFrames(first.rest, chunk2);
    expect(second.frames.length).toBe(1);
    expect(Array.from(second.frames[0]!)).toEqual(full);
    expect(second.rest.length).toBe(0);
  });

  test("SOI marker itself split across chunk boundary (trailing lone 0xFF) -> reassembled, not dropped", () => {
    const full = jpeg([7, 7]);
    const chunk1 = new Uint8Array([0xaa, 0xbb, 0xff]); // garbage, then a lone leading byte of the SOI
    const chunk2 = new Uint8Array([0xd8, ...full.slice(2)]); // completes SOI, then rest of frame

    const first = splitJpegFrames(new Uint8Array(0), chunk1);
    expect(first.frames.length).toBe(0);
    expect(Array.from(first.rest)).toEqual([0xff]); // garbage dropped, lone 0xFF kept

    const second = splitJpegFrames(first.rest, chunk2);
    expect(second.frames.length).toBe(1);
    expect(Array.from(second.frames[0]!)).toEqual(full);
  });

  test("garbage bytes before the first SOI are dropped, never surfaced as a frame", () => {
    const chunk = new Uint8Array([0x00, 0x11, 0x22, ...jpeg([5])]);
    const { frames, rest } = splitJpegFrames(new Uint8Array(0), chunk);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!)).toEqual(jpeg([5]));
    expect(rest.length).toBe(0);
  });

  test("no SOI anywhere -> no frames, empty rest (all dropped as garbage)", () => {
    const chunk = new Uint8Array([0x00, 0x11, 0x22, 0x33]);
    const { frames, rest } = splitJpegFrames(new Uint8Array(0), chunk);
    expect(frames.length).toBe(0);
    expect(rest.length).toBe(0);
  });

  test("empty chunk -> no frames, rest unchanged from pending", () => {
    const { frames, rest } = splitJpegFrames(new Uint8Array(0), new Uint8Array(0));
    expect(frames.length).toBe(0);
    expect(rest.length).toBe(0);
  });
});

/**
 * Unit tests for the web-drawn custom 4x4 marker: pure encoding
 * (patternToCode) plus a LIVE integration test against the real js-aruco2
 * library (imported separately here -- module resolution caches "js-aruco2"
 * by path, so this is the SAME AR.DICTIONARIES registry registerCustomMarker
 * mutates, not a separate instance). This is the strongest possible check
 * that a pattern drawn in the web UI is actually detectable: it registers a
 * pattern, then drives the real AR.Dictionary/AR.Detector rotation-search
 * exactly as getMarker() in js-aruco2/src/aruco.js does, confirming
 * detection at all 4 camera rotations relative to how it was printed.
 */
describe("custom marker (patternToCode / registerCustomMarker)", () => {
  // A hand-picked, asymmetric 16-cell pattern (row-major, true = white) --
  // asymmetric so rotated copies are never accidentally equal to each other,
  // which would make the rotation-invariance assertions below meaningless.
  const pattern = [
    true, false, true, false,
    false, true, false, true,
    true, true, false, false,
    false, false, true, true,
  ];

  test("patternToCode encodes MSB-first, row-major", () => {
    expect(patternToCode(pattern)).toBe(0b1010010111000011);
    expect(patternToCode(new Array(CUSTOM_MARKER_BITS).fill(false))).toBe(0);
    expect(patternToCode(new Array(CUSTOM_MARKER_BITS).fill(true))).toBe(0xffff);
  });

  test("patternToCode throws on the wrong cell count", () => {
    expect(() => patternToCode(new Array(CUSTOM_MARKER_BITS - 1).fill(true))).toThrow();
    expect(() => patternToCode(new Array(CUSTOM_MARKER_BITS + 1).fill(true))).toThrow();
  });

  test("a registered pattern is found by the real js-aruco2 dictionary at every camera rotation", async () => {
    // @ts-expect-error -- untyped module, see tracking.ts's own import
    const { AR } = await import("js-aruco2");
    registerCustomMarker(pattern, 4);

    const dict = new AR.Dictionary(CUSTOM_MARKER_DICT_NAME);
    // Mirrors AR.Detector.prototype.rotate exactly (js-aruco2/src/aruco.js)
    // -- reimplemented locally (not read off a Detector instance) so this
    // test doesn't need an inline shape cast for an untyped module.
    function rotate(src: number[][]): number[][] {
      const len = src.length;
      const dst: number[][] = [];
      for (let i = 0; i < len; i++) {
        dst.push([]);
        for (let j = 0; j < len; j++) dst[i]!.push(src[len - j - 1]![i]!);
      }
      return dst;
    }

    const size = Math.sqrt(CUSTOM_MARKER_BITS);
    let bits2d: number[][] = [];
    for (let y = 0; y < size; y++) bits2d.push(pattern.slice(y * size, (y + 1) * size).map((b) => (b ? 1 : 0)));

    // Mirrors AR.Detector.prototype.getMarker's own 4-rotation search loop
    // exactly (js-aruco2/src/aruco.js) -- if a camera saw the printed marker
    // rotated by 0/90/180/270 degrees, this is how it recovers the id.
    function searchAllRotations(initial: number[][]) {
      const rotations = [initial];
      let foundMin: { id: number; distance: number } | null = null;
      for (let i = 0; i < 4; i++) {
        const found = dict.find(rotations[i]!);
        if (found && (foundMin === null || found.distance < foundMin.distance)) {
          foundMin = found;
          if (found.distance === 0) break; // `found` (not foundMin) -- already non-null-checked above
        }
        rotations[i + 1] = rotate(rotations[i]!);
      }
      return foundMin;
    }

    let cameraView = bits2d;
    for (let r = 0; r < 4; r++) {
      expect(searchAllRotations(cameraView)).toEqual({ id: 0, distance: 0 });
      cameraView = rotate(cameraView);
    }
  });

  test("an unrelated pattern beyond tau does not match", async () => {
    // @ts-expect-error -- untyped module, see tracking.ts's own import
    const { AR } = await import("js-aruco2");
    registerCustomMarker(pattern, 4);
    const dict = new AR.Dictionary(CUSTOM_MARKER_DICT_NAME);

    // Inverts every cell -- maximally different (16 bits flipped), nowhere
    // near tau=4 regardless of rotation.
    const size = Math.sqrt(CUSTOM_MARKER_BITS);
    const inverted = pattern.map((b) => !b);
    const bits2d: number[][] = [];
    for (let y = 0; y < size; y++) bits2d.push(inverted.slice(y * size, (y + 1) * size).map((b) => (b ? 1 : 0)));

    expect(dict.find(bits2d)).toBeFalsy();
  });

  test("tau=0 is clamped to 1, never the js-aruco2 `dictionary.tau || _calculateTau()` runaway match-anything bug", async () => {
    // @ts-expect-error -- untyped module, see tracking.ts's own import
    const { AR } = await import("js-aruco2");
    registerCustomMarker(pattern, 0);
    expect(AR.DICTIONARIES[CUSTOM_MARKER_DICT_NAME]!.tau).toBe(1);

    const dict = new AR.Dictionary(CUSTOM_MARKER_DICT_NAME);
    // Without the clamp, js-aruco2's `dictionary.tau || this._calculateTau()`
    // treats tau:0 as falsy and silently substitutes Number.MAX_VALUE for a
    // single-entry codeList (see registerCustomMarker's doc comment) --
    // which would make even this maximally-different, fully-inverted
    // pattern (16/16 bits flipped) register as "found". Confirms it does
    // NOT, at any rotation.
    const size = Math.sqrt(CUSTOM_MARKER_BITS);
    const inverted = pattern.map((b) => !b);
    let bits2d: number[][] = [];
    for (let y = 0; y < size; y++) bits2d.push(inverted.slice(y * size, (y + 1) * size).map((b) => (b ? 1 : 0)));
    function rotate(src: number[][]): number[][] {
      const len = src.length;
      const dst: number[][] = [];
      for (let i = 0; i < len; i++) {
        dst.push([]);
        for (let j = 0; j < len; j++) dst[i]!.push(src[len - j - 1]![i]!);
      }
      return dst;
    }
    for (let r = 0; r < 4; r++) {
      expect(dict.find(bits2d)).toBeFalsy();
      bits2d = rotate(bits2d);
    }
  });

  test("re-registering overwrites the previous pattern (only one active marker)", async () => {
    // @ts-expect-error -- untyped module, see tracking.ts's own import
    const { AR } = await import("js-aruco2");
    registerCustomMarker(pattern, 4);
    const other = pattern.map((b) => !b);
    registerCustomMarker(other, 4);

    const dict = new AR.Dictionary(CUSTOM_MARKER_DICT_NAME);
    expect(dict.codeList.length).toBe(1); // still exactly one marker, not accumulated
    expect(dict.codeList[0]).toBe(patternToCode(other).toString(2).padStart(CUSTOM_MARKER_BITS, "0"));
  });
});
