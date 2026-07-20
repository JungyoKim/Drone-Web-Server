import { test, expect, describe } from "bun:test";
import { computeSteering, pickTargetMarker, type SteeringConfig } from "./tracking.ts";

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
