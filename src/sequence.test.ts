import { test, expect, describe, afterAll } from "bun:test";
import type { SequenceStop } from "./server.ts";
import type { DroneCommand } from "./protocol.ts";

/**
 * Unit tests for the safety-critical sequencer `runCommandSequence`. We drive it
 * with a FAKE `run` callback only — never real dispatch / WebSocket / network —
 * and assert the observable contract: ordering, per-outcome stop reason, the
 * `executed` count, and that `onStop` fires exactly once with the final reason.
 *
 * Neutralizing the import side effect: `server.ts` calls
 * `Bun.serve({ port: config.port })` at module top level, and `config.ts`
 * captures `Bun.env.PORT` at evaluation time. A static import is hoisted above
 * every statement, so there is no seam to set PORT=0 before the module runs.
 * We therefore force an ephemeral port, then reach the value bindings via a
 * runtime import (the module-loading-boundary exception to the static-import
 * rule), and shut the listener down in `afterAll`.
 */
Bun.env.PORT ??= "0";
const { runCommandSequence, server } = await import("./server.ts");

afterAll(() => {
  // Fully stop the ephemeral listener so the test process exits cleanly.
  server.stop(true);
});

type Stop = { reason: SequenceStop; cmd?: DroneCommand };

describe("runCommandSequence", () => {
  test("all succeed -> reason done, executes every command in order", async () => {
    const commands: DroneCommand[] = [
      { action: "takeoff" },
      { action: "forward", distance: 100 },
      { action: "land" },
    ];
    const seq = { aborted: false };
    const calls: string[] = [];
    const args: Array<[number, number]> = [];
    const run = async (cmd: DroneCommand, index: number, total: number) => {
      calls.push(cmd.action);
      args.push([index, total]);
      return { ok: true };
    };
    const stops: Stop[] = [];

    const result = await runCommandSequence(commands, seq, run, (reason, cmd) =>
      stops.push({ reason, cmd }),
    );

    expect(result).toEqual({ executed: 3, reason: "done" });
    // Order is the contract: exactly one call per command, front to back.
    expect(calls).toEqual(["takeoff", "forward", "land"]);
    // index/total are passed through correctly for each step.
    expect(args).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(stops).toEqual([{ reason: "done", cmd: undefined }]);
  });

  test("strictly sequential: step i+1 waits for step i's promise to resolve", async () => {
    const commands: DroneCommand[] = [
      { action: "takeoff" },
      { action: "up", distance: 50 },
      { action: "land" },
    ];
    const seq = { aborted: false };
    const log: string[] = [];
    const run = async (cmd: DroneCommand) => {
      log.push(`start:${cmd.action}`);
      // Yield across several microtasks. If the sequencer fired steps
      // concurrently (missing await), the starts would bunch up before any
      // finish and the strict start/finish interleaving below would break.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      log.push(`finish:${cmd.action}`);
      return { ok: true };
    };

    const result = await runCommandSequence(commands, seq, run);

    expect(result).toEqual({ executed: 3, reason: "done" });
    expect(log).toEqual([
      "start:takeoff",
      "finish:takeoff",
      "start:up",
      "finish:up",
      "start:land",
      "finish:land",
    ]);
  });

  test("pre-aborted sequence -> run never called, reason aborted, executed 0", async () => {
    const first: DroneCommand = { action: "takeoff" };
    const commands: DroneCommand[] = [first, { action: "land" }];
    const seq = { aborted: true };
    let runCalls = 0;
    const run = async () => {
      runCalls++;
      return { ok: true };
    };
    const stops: Stop[] = [];

    const result = await runCommandSequence(commands, seq, run, (reason, cmd) =>
      stops.push({ reason, cmd }),
    );

    expect(runCalls).toBe(0);
    expect(result).toEqual({ executed: 0, reason: "aborted" });
    // Reports the command it stopped in front of (the first, never dispatched).
    expect(stops).toEqual([{ reason: "aborted", cmd: first }]);
  });

  test("abort landing mid-step -> stops after that step, executed 1, rest skipped", async () => {
    const commands: DroneCommand[] = [
      { action: "takeoff" },
      { action: "forward", distance: 100 },
      { action: "land" },
    ];
    const seq = { aborted: false };
    const calls: string[] = [];
    const run = async (cmd: DroneCommand) => {
      calls.push(cmd.action);
      // Emergency lands while the first step's reply is still in flight.
      if (cmd.action === "takeoff") seq.aborted = true;
      return { ok: true };
    };
    const stops: Stop[] = [];

    const result = await runCommandSequence(commands, seq, run, (reason, cmd) =>
      stops.push({ reason, cmd }),
    );

    // The completed step still counts, but the post-step abort halts the rest.
    expect(result).toEqual({ executed: 1, reason: "aborted" });
    expect(calls).toEqual(["takeoff"]);
    expect(stops).toEqual([{ reason: "aborted", cmd: { action: "takeoff" } }]);
  });

  test("a step reports not-ok -> reason failed, executed includes that step, rest skipped", async () => {
    const failing: DroneCommand = { action: "forward", distance: 100 };
    const commands: DroneCommand[] = [{ action: "takeoff" }, failing, { action: "land" }];
    const seq = { aborted: false };
    const calls: string[] = [];
    const run = async (cmd: DroneCommand) => {
      calls.push(cmd.action);
      return { ok: cmd.action !== "forward" };
    };
    const stops: Stop[] = [];

    const result = await runCommandSequence(commands, seq, run, (reason, cmd) =>
      stops.push({ reason, cmd }),
    );

    // takeoff (1) + forward (2, the one that reported !ok); land never runs.
    expect(result).toEqual({ executed: 2, reason: "failed" });
    expect(calls).toEqual(["takeoff", "forward"]);
    expect(stops).toEqual([{ reason: "failed", cmd: failing }]);
  });

  test("a step errors -> reason error, executed EXCLUDES the errored step, rest skipped", async () => {
    const offline: DroneCommand = { action: "forward", distance: 100 };
    const commands: DroneCommand[] = [{ action: "takeoff" }, offline, { action: "land" }];
    const seq = { aborted: false };
    const calls: string[] = [];
    const run = async (cmd: DroneCommand) => {
      calls.push(cmd.action);
      if (cmd.action === "forward") return { error: "device offline" };
      return { ok: true };
    };
    const stops: Stop[] = [];

    const result = await runCommandSequence(commands, seq, run, (reason, cmd) =>
      stops.push({ reason, cmd }),
    );

    // takeoff succeeded (1); the errored forward is NOT counted; land never runs.
    expect(result).toEqual({ executed: 1, reason: "error" });
    expect(calls).toEqual(["takeoff", "forward"]);
    expect(stops).toEqual([{ reason: "error", cmd: offline }]);
  });

  test("onStop fires exactly once with the final reason", async () => {
    const commands: DroneCommand[] = [{ action: "takeoff" }, { action: "land" }];
    const seq = { aborted: false };
    const run = async () => ({ ok: true });
    const reasons: SequenceStop[] = [];

    const result = await runCommandSequence(commands, seq, run, (reason) => reasons.push(reason));

    expect(result.reason).toBe("done");
    expect(reasons).toEqual(["done"]);
  });
});
