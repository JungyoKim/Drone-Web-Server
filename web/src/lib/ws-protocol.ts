/**
 * Re-exports the Bun backend's wire contract for the frontend. Single point
 * of contact with ../../../src/protocol.ts -- every component imports the
 * message/command types from here, never from the backend path directly, so
 * updating this one file is the only place a cross-root import depth lives.
 *
 * This is a TYPE-ONLY re-export (no runtime code crosses the boundary): the
 * frontend and backend are still separately built/deployed, but they can
 * never drift on message shapes without a compile error here.
 */
export type {
  DroneAction,
  DroneCommand,
  BrowserToServer,
  ServerToBrowser,
  DeviceToServer,
  ServerToDevice,
} from "../../../src/protocol.ts";
export { LIMITS, RC } from "../../../src/protocol.ts";
