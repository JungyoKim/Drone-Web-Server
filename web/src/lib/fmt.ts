import type { DroneCommand } from "./ws-protocol";

/** Human-readable rendering of a structured command, e.g. "forward 100cm". */
export function fmtCmd(c: DroneCommand | null | undefined): string {
  if (!c || typeof c.action !== "string") return "?";
  let s: string = c.action;
  if (typeof c.distance === "number") s += ` ${c.distance}cm`;
  if (typeof c.degree === "number") s += ` ${c.degree}\u00b0`;
  if (c.dir) s += ` ${c.dir}`;
  return s;
}
