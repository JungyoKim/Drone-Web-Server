import { LIMITS, type DroneCommand, type DroneAction } from "./protocol.ts";

/** Result of validating/mapping a command to a Tello SDK string. */
export type MapResult =
  | { ok: true; tello: string; command: DroneCommand }
  | { ok: false; error: string };

const MOVE_ACTIONS: Partial<Record<DroneAction, true>> = {
  up: true, down: true, left: true, right: true, forward: true, back: true,
};
const ROTATE_ACTIONS: Partial<Record<DroneAction, true>> = { cw: true, ccw: true };
const FLIP_DIRS: Record<string, true> = { l: true, r: true, f: true, b: true };

function clampIntInRange(v: number, min: number, max: number): number | null {
  if (!Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < min || n > max) return null;
  return n;
}

/**
 * Validate a structured command and produce the exact Tello SDK text string.
 * Rejects out-of-range args rather than silently clamping — a drone that flies
 * a different distance than the user said is worse than a rejected command.
 */
export function mapCommand(cmd: DroneCommand): MapResult {
  const { action } = cmd;

  if (action === "takeoff") return { ok: true, tello: "takeoff", command: { action } };
  if (action === "land") return { ok: true, tello: "land", command: { action } };
  if (action === "emergency") return { ok: true, tello: "emergency", command: { action } };
  if (action === "battery") return { ok: true, tello: "battery?", command: { action } };
  if (action === "streamon") return { ok: true, tello: "streamon", command: { action } };
  if (action === "streamoff") return { ok: true, tello: "streamoff", command: { action } };

  if (MOVE_ACTIONS[action]) {
    const { min, max } = LIMITS.distanceCm;
    const d = clampIntInRange(cmd.distance ?? NaN, min, max);
    if (d === null) return { ok: false, error: `distance must be ${min}-${max}cm (got ${cmd.distance})` };
    return { ok: true, tello: `${action} ${d}`, command: { action, distance: d } };
  }

  if (ROTATE_ACTIONS[action]) {
    const { min, max } = LIMITS.degree;
    const deg = clampIntInRange(cmd.degree ?? NaN, min, max);
    if (deg === null) return { ok: false, error: `degree must be ${min}-${max} (got ${cmd.degree})` };
    return { ok: true, tello: `${action} ${deg}`, command: { action, degree: deg } };
  }

  if (action === "flip") {
    const dir = cmd.dir;
    if (!dir || !FLIP_DIRS[dir]) return { ok: false, error: `flip dir must be l/r/f/b (got ${dir})` };
    return { ok: true, tello: `flip ${dir}`, command: { action, dir } };
  }

  return { ok: false, error: `unknown action: ${action}` };
}

/** Parse a raw Tello reply string into (ok, value). "ok" -> success; numbers for battery?. */
export function parseTelloReply(raw: string): { ok: boolean; value: string } {
  const v = raw.trim();
  if (v.toLowerCase() === "ok") return { ok: true, value: v };
  if (/^-?\d+$/.test(v)) return { ok: true, value: v }; // e.g. battery? -> "87"
  return { ok: false, value: v }; // "error", "error Not joystick", etc.
}
