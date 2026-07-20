import { test, expect, describe } from "bun:test";

// The backend's real implementation (../../../src/tracking.ts, i.e. repo-root
// src/tracking.ts from this file's location at web/src/lib/) -- a genuine
// RUNTIME import, not type-only, since this test itself executes under Bun
// (the backend's own test runner), not inside the browser bundle where a
// cross-root import would be impossible. This is the mirror-verification
// contract local-track-protocol.md calls for: web/src/lib/tracking.ts must
// be provably byte-identical in BEHAVIOR (not source text) to this module.
import * as backend from "../../../src/tracking.ts";
import * as web from "./tracking.ts";

/**
 * Cross-checks the browser-side mirror (web/src/lib/tracking.ts) against the
 * real backend module (src/tracking.ts) it hand-copies -- every pure
 * function exercised with the SAME representative inputs, asserting IDENTICAL
 * outputs from both. This is the thing that keeps the two files from
 * silently drifting apart over time (no shared source, so nothing else
 * would catch it). Inputs mirror src/tracking.test.ts's own fixtures
 * (matching corners, marker ids, tau edge cases) rather than inventing a
 * separate fixture set, so both suites are provably exercising the same
 * scenarios.
 */

const baseCfg: web.SteeringConfig = {
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

describe("constants match", () => {
  test("CUSTOM_MARKER_BITS / CUSTOM_MARKER_DICT_NAME identical", () => {
    expect(web.CUSTOM_MARKER_BITS).toBe(backend.CUSTOM_MARKER_BITS);
    expect(web.CUSTOM_MARKER_DICT_NAME).toBe(backend.CUSTOM_MARKER_DICT_NAME);
  });
});

describe("patternToCode matches backend", () => {
  const patterns: boolean[][] = [
    new Array(16).fill(false),
    new Array(16).fill(true),
    [true, false, true, false, false, true, false, true, true, true, false, false, false, false, true, true],
    [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true],
  ];

  test("identical code for every representative pattern", () => {
    for (const pattern of patterns) {
      expect(web.patternToCode(pattern)).toBe(backend.patternToCode(pattern));
    }
  });

  test("identical throw behavior on wrong cell count", () => {
    expect(() => web.patternToCode(new Array(15).fill(true))).toThrow();
    expect(() => backend.patternToCode(new Array(15).fill(true))).toThrow();
    expect(() => web.patternToCode(new Array(17).fill(true))).toThrow();
    expect(() => backend.patternToCode(new Array(17).fill(true))).toThrow();
  });
});

describe("registerCustomMarker matches backend", () => {
  // web/src/lib/tracking.ts loads its OWN independent js-aruco2 instance
  // (evaluated from raw source text -- see that file's loading comment)
  // rather than sharing the "js-aruco2" package's Node/Bun module-cache
  // singleton the backend uses. That's correct for the real deployment
  // (web and backend are separately built/deployed, per ws-protocol.ts's
  // convention comment), so these tests verify each side's registration
  // independently -- web via its own __getDictionaryForTest accessor,
  // backend via the shared "js-aruco2" singleton (matching
  // src/tracking.test.ts's own precedent) -- rather than assuming a
  // shared object identity that no longer holds.
  test("both sides register an equivalent dictionary entry for the same pattern/tau", async () => {
    // Dynamic (not static) import, matching src/tracking.test.ts's own
    // precedent: reaches past the backend's deliberately-private `AR`
    // binding to inspect its dictionary singleton directly, a test-only
    // escape hatch.
    // @ts-expect-error -- untyped module, same pattern as tracking.ts's own import
    const { AR } = await import("js-aruco2");
    const pattern = [
      true, false, true, false, false, true, false, true, true, true, false, false, false, false, true, true,
    ];

    web.registerCustomMarker(pattern, 4);
    const afterWeb = web.__getDictionaryForTest(web.CUSTOM_MARKER_DICT_NAME);

    backend.registerCustomMarker(pattern, 4);
    const afterBackend = AR.DICTIONARIES[backend.CUSTOM_MARKER_DICT_NAME];

    expect(afterWeb).toEqual(afterBackend);
  });

  test("tau=0 edge case: both clamp to 1, never js-aruco2's match-anything fallback", async () => {
    // @ts-expect-error -- untyped module, same pattern as tracking.ts's own import
    const { AR } = await import("js-aruco2");
    const pattern = new Array(16).fill(true);

    web.registerCustomMarker(pattern, 0);
    expect(web.__getDictionaryForTest(web.CUSTOM_MARKER_DICT_NAME)?.tau).toBe(1);

    backend.registerCustomMarker(pattern, 0);
    expect(AR.DICTIONARIES[backend.CUSTOM_MARKER_DICT_NAME].tau).toBe(1);
  });

  test("negative tau edge case: both clamp to 1 identically", async () => {
    // @ts-expect-error -- untyped module, same pattern as tracking.ts's own import
    const { AR } = await import("js-aruco2");
    const pattern = new Array(16).fill(false);

    web.registerCustomMarker(pattern, -5);
    const webTau = web.__getDictionaryForTest(web.CUSTOM_MARKER_DICT_NAME)?.tau;
    backend.registerCustomMarker(pattern, -5);
    const backendTau = AR.DICTIONARIES[backend.CUSTOM_MARKER_DICT_NAME].tau;
    expect(webTau).toBe(1);
    expect(backendTau).toBe(1);
  });
});

describe("pickTargetMarker matches backend", () => {
  const markers = [
    { id: 1, corners: square(100, 100, 10) },
    { id: 2, corners: square(200, 200, 50) },
    { id: 3, corners: square(300, 300, 5) },
  ];

  test("targetMarkerId set -> identical pick", () => {
    expect(web.pickTargetMarker(markers, 2)).toEqual(backend.pickTargetMarker(markers, 2));
  });

  test("targetMarkerId set but nothing matches -> both null", () => {
    expect(web.pickTargetMarker(markers, 99)).toBeNull();
    expect(backend.pickTargetMarker(markers, 99)).toBeNull();
  });

  test("empty list -> both null", () => {
    expect(web.pickTargetMarker([], undefined)).toBeNull();
    expect(backend.pickTargetMarker([], undefined)).toBeNull();
  });

  test("targetMarkerId unset -> identical largest-size pick", () => {
    expect(web.pickTargetMarker(markers, undefined)).toEqual(backend.pickTargetMarker(markers, undefined));
  });
});

describe("computeSteering matches backend", () => {
  test("no marker -> identical all-zero result", () => {
    expect(web.computeSteering(null, undefined, baseCfg)).toEqual(backend.computeSteering(null, undefined, baseCfg));
  });

  test("marker exactly centered at target size -> identical zero-rc result", () => {
    const corners = square(baseCfg.frameWidth / 2, baseCfg.frameHeight / 2, 50);
    expect(web.computeSteering(corners, 7, baseCfg)).toEqual(backend.computeSteering(corners, 7, baseCfg));
  });

  test("marker off-center right/left, above/below -> identical dx/dy/rc for every direction", () => {
    const cases: { x: number; y: number }[] = [
      { x: baseCfg.frameWidth / 2 + 200, y: baseCfg.frameHeight / 2 },
      { x: baseCfg.frameWidth / 2 - 200, y: baseCfg.frameHeight / 2 },
      { x: baseCfg.frameWidth / 2, y: baseCfg.frameHeight / 2 + 200 },
      { x: baseCfg.frameWidth / 2, y: baseCfg.frameHeight / 2 - 200 },
    ];
    for (const { x, y } of cases) {
      const corners = square(x, y, 50);
      expect(web.computeSteering(corners, 1, baseCfg)).toEqual(backend.computeSteering(corners, 1, baseCfg));
    }
  });

  test("too close / too far (sizeRatio far from 1) -> identical b channel", () => {
    const roomyCfg: web.SteeringConfig = { ...baseCfg, maxRc: 1000 };
    const closeCorners = square(roomyCfg.frameWidth / 2, roomyCfg.frameHeight / 2, 100);
    expect(web.computeSteering(closeCorners, 1, roomyCfg)).toEqual(backend.computeSteering(closeCorners, 1, roomyCfg));

    const farCorners = square(baseCfg.frameWidth / 2, baseCfg.frameHeight / 2, 25);
    expect(web.computeSteering(farCorners, 1, baseCfg)).toEqual(backend.computeSteering(farCorners, 1, baseCfg));
  });

  test("extreme gains -> identical clamp to +-maxRc on every channel", () => {
    const hotCfg: web.SteeringConfig = { ...baseCfg, yawGain: 10000, altGain: 10000, distGain: 10000 };
    const corners = square(baseCfg.frameWidth / 2 + 200, baseCfg.frameHeight / 2 + 200, 200);
    expect(web.computeSteering(corners, 1, hotCfg)).toEqual(backend.computeSteering(corners, 1, hotCfg));

    const leftCorners = square(baseCfg.frameWidth / 2 - 200, baseCfg.frameHeight / 2, 50);
    expect(web.computeSteering(leftCorners, 1, hotCfg)).toEqual(backend.computeSteering(leftCorners, 1, hotCfg));
  });

  test("rc.a always 0 in both, across varied inputs", () => {
    expect(web.computeSteering(null, undefined, baseCfg).rc.a).toBe(0);
    expect(backend.computeSteering(null, undefined, baseCfg).rc.a).toBe(0);
    const corners = square(10, 10, 5);
    const hotCfg: web.SteeringConfig = { ...baseCfg, yawGain: 99999, altGain: 99999 };
    expect(web.computeSteering(corners, 3, hotCfg).rc.a).toBe(0);
    expect(backend.computeSteering(corners, 3, hotCfg).rc.a).toBe(0);
  });
});

describe("createArucoDetector (web-only glue, not present on the backend module)", () => {
  test("constructs a detector exposing the streaming API js-aruco2 provides", () => {
    const detector = web.createArucoDetector();
    expect(typeof detector.detectStreamInit).toBe("function");
    expect(typeof detector.detectStream).toBe("function");
  });
});

describe("web's independently-loaded js-aruco2 instance is fully intact", () => {
  // web/src/lib/tracking.ts loads js-aruco2 by evaluating its raw source
  // text (see that file's loading comment) rather than a normal module
  // import, specifically to survive Vite/Rolldown's production bundler --
  // this proves that mechanism actually produced a COMPLETE, correct
  // runtime (not a partial/broken eval) by cross-checking one of its
  // built-in dictionaries byte-for-byte against the backend's real
  // "js-aruco2" package instance, the same way the custom-marker tests
  // above check registerCustomMarker's effect.
  test("built-in ARUCO_MIP_36h12 dictionary matches the real js-aruco2 package exactly", async () => {
    // @ts-expect-error -- untyped module, same pattern as tracking.ts's own import
    const { AR: backendAruco } = await import("js-aruco2");
    const webDict = web.__getDictionaryForTest(web.DEFAULT_ARUCO_DICTIONARY);
    const backendDict = backendAruco.DICTIONARIES[web.DEFAULT_ARUCO_DICTIONARY];

    expect(webDict).toBeDefined();
    expect(webDict!.nBits).toBe(backendDict.nBits);
    expect(webDict!.tau).toBe(backendDict.tau);
    expect(webDict!.codeList.length).toBe(backendDict.codeList.length);
    expect(webDict!.codeList).toEqual(backendDict.codeList);
  });
});
