import { test, expect, describe } from "bun:test";
import { mapCommand, parseTelloReply } from "./tello.ts";

describe("mapCommand", () => {
  test("simple actions map to bare strings", () => {
    expect(mapCommand({ action: "takeoff" })).toEqual({ ok: true, tello: "takeoff", command: { action: "takeoff" } });
    expect(mapCommand({ action: "land" })).toMatchObject({ ok: true, tello: "land" });
    expect(mapCommand({ action: "emergency" })).toMatchObject({ ok: true, tello: "emergency" });
    expect(mapCommand({ action: "battery" })).toMatchObject({ ok: true, tello: "battery?" });
  });

  test("moves require in-range distance and round", () => {
    expect(mapCommand({ action: "forward", distance: 100 })).toMatchObject({ ok: true, tello: "forward 100" });
    expect(mapCommand({ action: "up", distance: 20 })).toMatchObject({ ok: true, tello: "up 20" });
    expect(mapCommand({ action: "back", distance: 500 })).toMatchObject({ ok: true, tello: "back 500" });
    expect(mapCommand({ action: "left", distance: 49.6 })).toMatchObject({ ok: true, tello: "left 50" });
  });

  test("moves reject out-of-range / missing distance", () => {
    expect(mapCommand({ action: "forward", distance: 19 }).ok).toBe(false);
    expect(mapCommand({ action: "forward", distance: 501 }).ok).toBe(false);
    expect(mapCommand({ action: "forward" }).ok).toBe(false);
  });

  test("rotation requires in-range degree", () => {
    expect(mapCommand({ action: "cw", degree: 90 })).toMatchObject({ ok: true, tello: "cw 90" });
    expect(mapCommand({ action: "ccw", degree: 360 })).toMatchObject({ ok: true, tello: "ccw 360" });
    expect(mapCommand({ action: "cw", degree: 0 }).ok).toBe(false);
    expect(mapCommand({ action: "cw", degree: 361 }).ok).toBe(false);
    expect(mapCommand({ action: "cw" }).ok).toBe(false);
  });

  test("flip requires valid dir", () => {
    expect(mapCommand({ action: "flip", dir: "l" })).toMatchObject({ ok: true, tello: "flip l" });
    expect(mapCommand({ action: "flip", dir: "b" })).toMatchObject({ ok: true, tello: "flip b" });
    expect(mapCommand({ action: "flip" }).ok).toBe(false);
    // @ts-expect-error invalid dir
    expect(mapCommand({ action: "flip", dir: "x" }).ok).toBe(false);
  });
});

describe("parseTelloReply", () => {
  test("ok is success", () => {
    expect(parseTelloReply("ok")).toEqual({ ok: true, value: "ok" });
    expect(parseTelloReply("OK\r\n")).toEqual({ ok: true, value: "OK" });
  });
  test("numeric telemetry is success", () => {
    expect(parseTelloReply("87")).toEqual({ ok: true, value: "87" });
  });
  test("error strings are failure", () => {
    expect(parseTelloReply("error").ok).toBe(false);
    expect(parseTelloReply("error Not joystick").ok).toBe(false);
  });
});
