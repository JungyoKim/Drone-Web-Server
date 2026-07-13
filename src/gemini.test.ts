import { test, expect, describe } from "bun:test";
import { withRetry } from "./gemini.ts";

/**
 * Unit tests for withRetry. Every call passes baseDelayMs = 0 so the exponential
 * backoff resolves without a real wall-clock wait. We only exercise the retry
 * contract via fake thunks — never the real Gemini client.
 */
describe("withRetry", () => {
  test("resolves on first success without retrying", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return "landed";
    };
    expect(await withRetry(fn, 3, 0)).toBe("landed");
    expect(calls).toBe(1);
  });

  test("retries a transient error then resolves", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error("429 rate limited");
      if (calls === 2) throw new Error("RESOURCE_EXHAUSTED: quota");
      return "recovered";
    };
    expect(await withRetry(fn, 3, 0)).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("exhausts attempts on a persistent transient error and rethrows the last error", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error(`429 failure #${calls}`);
    };
    // The last attempt (#3) is the error that must propagate.
    await expect(withRetry(fn, 3, 0)).rejects.toThrow("429 failure #3");
    expect(calls).toBe(3);
  });

  test("rethrows a non-transient error immediately without retrying", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("400 invalid argument");
    };
    await expect(withRetry(fn, 3, 0)).rejects.toThrow("400 invalid argument");
    expect(calls).toBe(1);
  });

  describe("recognizes each transient pattern (retries instead of throwing)", () => {
    const transientMessages = [
      "429 Too Many Requests",
      "RESOURCE_EXHAUSTED: quota exceeded",
      "503 Service Unavailable",
      "UNAVAILABLE: backend is down",
      "The model is overloaded. Please try again later.",
    ];
    for (const msg of transientMessages) {
      test(`retries on "${msg}"`, async () => {
        let calls = 0;
        const fn = async () => {
          calls++;
          if (calls === 1) throw new Error(msg);
          return "recovered";
        };
        expect(await withRetry(fn, 2, 0)).toBe("recovered");
        expect(calls).toBe(2);
      });
    }
  });
});
