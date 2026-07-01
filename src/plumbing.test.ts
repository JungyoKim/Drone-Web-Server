import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import type { ServerToBrowser, ServerToDevice } from "./protocol.ts";

/**
 * End-to-end plumbing: spawns the real backend as a subprocess (no Gemini key
 * needed — exercises the direct `command` path), then drives a simulated browser
 * and a simulated ESP32 device over WebSocket to verify the relay round-trip.
 */

const PORT = 8199;
const BASE = `localhost:${PORT}`;
const DEVICE_TOKEN = "test-device";
const BROWSER_TOKEN = "test-browser";

type DeviceCommand = Extract<ServerToDevice, { type: "command" }>;
type BrowserStatus = Extract<ServerToBrowser, { type: "status" }>;
type BrowserError = Extract<ServerToBrowser, { type: "error" }>;

let proc: Subprocess;

/** Buffered WS client that lets tests await the next message matching a predicate. */
class WsClient<Incoming> {
  #ws: WebSocket;
  #queue: Incoming[] = [];
  #waiter: { match: (m: Incoming) => boolean; resolve: (m: Incoming) => void } | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as Incoming;
      if (this.#waiter && this.#waiter.match(msg)) {
        const w = this.#waiter;
        this.#waiter = null;
        w.resolve(msg);
      } else {
        this.#queue.push(msg);
      }
    });
  }

  static open<T>(url: string): Promise<WsClient<T>> {
    const ws = new WebSocket(url);
    const { promise, resolve, reject } = Promise.withResolvers<WsClient<T>>();
    const client = new WsClient<T>(ws);
    ws.addEventListener("open", () => resolve(client));
    ws.addEventListener("error", () => reject(new Error(`ws error: ${url}`)));
    return promise;
  }

  send(msg: unknown): void {
    this.#ws.send(JSON.stringify(msg));
  }

  /** Resolve with the next message satisfying `match` (checks buffered first). */
  next(match: (m: Incoming) => boolean, timeoutMs = 3000): Promise<Incoming> {
    const idx = this.#queue.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.#queue.splice(idx, 1)[0]!);
    const { promise, resolve, reject } = Promise.withResolvers<Incoming>();
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    this.#waiter = {
      match,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    };
    return promise;
  }

  close(): void {
    this.#ws.close();
  }
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    env: { ...Bun.env, PORT: String(PORT), DEVICE_TOKEN, BROWSER_TOKEN, GEMINI_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Poll readiness. Real delay between attempts: we are waiting for a separate OS
  // process to bind its TCP port — there is no in-process signal or fake clock
  // that can advance another process's startup, so deterministic time control
  // does not apply here.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
  }
  throw new Error("server did not become ready");
});

afterAll(() => {
  proc?.kill();
});

/** Connect + authenticate a simulated device; returns it after `welcome ok`. */
async function connectDevice(): Promise<WsClient<ServerToDevice>> {
  const dev = await WsClient.open<ServerToDevice>(`ws://${BASE}/ws/device`);
  dev.send({ type: "hello", deviceId: "sim-esp32", token: DEVICE_TOKEN, fw: "test" });
  const welcome = await dev.next((m) => m.type === "welcome");
  expect(welcome).toMatchObject({ type: "welcome", ok: true });
  return dev;
}

async function connectBrowser(): Promise<WsClient<ServerToBrowser>> {
  return WsClient.open<ServerToBrowser>(`ws://${BASE}/ws/browser?token=${BROWSER_TOKEN}`);
}

describe("backend plumbing", () => {
  test("browser command relays to device and back", async () => {
    const dev = await connectDevice();
    const br = await connectBrowser();

    br.send({ type: "command", command: { action: "takeoff" } });

    const cmd = (await dev.next((m) => m.type === "command")) as DeviceCommand;
    expect(cmd).toMatchObject({ type: "command", tello: "takeoff" });

    dev.send({ type: "result", id: cmd.id, response: "ok", ok: true });

    const relayed = await br.next((m) => m.type === "tello");
    expect(relayed).toMatchObject({ type: "tello", response: "ok", ok: true });

    dev.close();
    br.close();
  });

  test("battery reply updates status battery", async () => {
    const dev = await connectDevice();
    const br = await connectBrowser();

    br.send({ type: "command", command: { action: "battery" } });
    const cmd = (await dev.next((m) => m.type === "command")) as DeviceCommand;
    expect(cmd).toMatchObject({ tello: "battery?" });
    dev.send({ type: "result", id: cmd.id, response: "87", ok: true });

    const status = (await br.next(
      (m) => m.type === "status" && (m as BrowserStatus).battery === 87,
    )) as BrowserStatus;
    expect(status).toMatchObject({ type: "status", battery: 87 });

    dev.close();
    br.close();
  });

  test("invalid command is rejected before dispatch", async () => {
    const dev = await connectDevice();
    const br = await connectBrowser();

    // Invalid (distance below min) then a valid follow-up. WS preserves order,
    // so if the invalid one had leaked, the device's NEXT command frame would be
    // "forward ..." — asserting it is the valid "takeoff" proves the invalid was
    // dropped pre-dispatch, with no reliance on a wall-clock wait.
    br.send({ type: "command", command: { action: "forward", distance: 5 } });
    br.send({ type: "command", command: { action: "takeoff" } });

    const err = (await br.next((m) => m.type === "error")) as BrowserError;
    expect(err.message).toContain("distance");

    const cmd = (await dev.next((m) => m.type === "command")) as DeviceCommand;
    expect(cmd.tello).toBe("takeoff");

    dev.close();
    br.close();
  });

  test("device telemetry broadcasts battery to browser", async () => {
    const dev = await connectDevice();
    const br = await connectBrowser();

    dev.send({ type: "telemetry", battery: 42 });
    const status = (await br.next(
      (m) => m.type === "status" && (m as BrowserStatus).battery === 42,
    )) as BrowserStatus;
    expect(status).toMatchObject({ type: "status", battery: 42, deviceOnline: true });

    dev.close();
    br.close();
  });
});
