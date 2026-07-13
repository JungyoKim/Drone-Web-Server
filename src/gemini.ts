import { GoogleGenAI, Type, FunctionCallingConfigMode, ThinkingLevel } from "@google/genai";
import { config } from "./config.ts";
import type { DroneCommand, DroneAction } from "./protocol.ts";

/** Lazily constructed so plumbing/tests don't require a key. */
let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

/**
 * Retry transient failures (429 rate-limit, 5xx) with exponential backoff.
 * The free tier returns 429 RESOURCE_EXHAUSTED under load; a couple of short
 * retries usually clears it. Non-transient errors (bad key, 400) rethrow at once.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 400): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /\b429\b|RESOURCE_EXHAUSTED|\b5\d\d\b|UNAVAILABLE|overloaded|timed out|timeout|aborted/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

/** Reject if `p` doesn't settle within `ms` — turns a silent network hang into
 * a visible error the UI can show. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "gemini"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Single function declaration the model maps speech onto. One function with an
 * `action` enum keeps the tool surface tiny and the parse unambiguous — the model
 * picks the action and fills only the relevant arg.
 */
const droneTool = {
  functionDeclarations: [
    {
      name: "control_drone",
      description:
        "Execute a single flight command on the Tello drone based on the user's spoken instruction.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: [
              "takeoff", "land", "emergency",
              "up", "down", "left", "right", "forward", "back",
              "cw", "ccw", "flip", "battery",
            ],
            description:
              "The flight action. up/down/left/right/forward/back need distance. cw (clockwise)/ccw (counter-clockwise) need degree. flip needs dir.",
          },
          distance: {
            type: Type.NUMBER,
            description: "Distance in centimeters (20-500) for movement actions.",
          },
          degree: {
            type: Type.NUMBER,
            description: "Rotation in degrees (1-360) for cw/ccw.",
          },
          dir: {
            type: Type.STRING,
            enum: ["l", "r", "f", "b"],
            description: "Flip direction: l=left, r=right, f=forward, b=back.",
          },
          heard: {
            type: Type.STRING,
            description: "Verbatim transcription of the Korean/English words you actually heard in the audio.",
          },
        },
        required: ["action"],
      },
    },
  ],
};

const SYSTEM_INSTRUCTION = `You translate a Korean (or English) spoken drone instruction into exactly one control_drone function call.
Rules:
- Always call control_drone exactly once. Never answer in text.
- Map natural language to actions: 이륙/뜨다/떠/날아=takeoff, 착륙/내려/내려와/랜딩/착지=land, 정지/비상/멈춰=emergency, 앞으로=forward, 뒤로=back, 위로=up, 아래로=down, 왼쪽=left, 오른쪽=right, 시계방향/우회전=cw, 반시계/좌회전=ccw, 뒤집기/플립=flip, 배터리=battery.
- CRITICAL: 이륙(takeoff, go UP) and 착륙(land, go DOWN) are OPPOSITES and sound similar (both end in 륙). Attend to the FIRST syllable: 이=takeoff, 착=land. When unsure between these two, prefer 착륙=land (the safer action) only if the first syllable clearly sounds like 착/차; otherwise takeoff.
- Also put what you heard, verbatim, in the "heard" argument.
- Convert units to the required ones: meters->centimeters (1미터=100). If a movement distance is unspecified, use 50. If a rotation degree is unspecified, use 90.
- Clamp intent to valid ranges: distance 20-500cm, degree 1-360. If the user asks beyond a range, pick the nearest valid value.`;

export interface ParseResult {
  command: DroneCommand;
  /** Human-readable echo of the interpreted command, for the UI. */
  raw: string;
  /** Verbatim transcription the model reported hearing, for the UI. */
  heard?: string;
}

/**
 * Send recorded audio to Gemini and get back one structured drone command via
 * function calling. Throws on no/invalid function call so the caller surfaces an error.
 */
export async function parseAudioCommand(audioBase64: string, mime: string): Promise<ParseResult> {
  const t0 = Date.now();
  // Gemini wants a bare audio mime; strip any "; codecs=..." parameter that
  // browsers (esp. iOS Safari -> "audio/mp4; codecs=mp4a.40.2") tack on.
  const cleanMime = (mime.split(";")[0] || "").trim() || "audio/mp4";
  console.log(`[gemini] request model=${config.geminiModel} mime=${cleanMime} audioB64=${audioBase64.length}B`);
  // Per-attempt timeout INSIDE the retry: when the model is overloaded an audio
  // request tends to hang (rather than return a fast 503). Capping each attempt
  // turns that hang into a retryable "timed out", so we retry (with backoff)
  // instead of blocking the whole budget on one stuck call.
  const res = await withRetry(() => withTimeout(getClient().models.generateContent({
    model: config.geminiModel,
    contents: [
      {
        role: "user",
        parts: [
          { text: "Here is the spoken instruction. Produce one control_drone call." },
          { inlineData: { mimeType: cleanMime, data: audioBase64 } },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: [droneTool],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["control_drone"] },
      },
      temperature: 0,
      // Minimize model "thinking" — this is a deterministic command map, not a
      // reasoning task. Cuts latency sharply on 3.x Flash (which thinks by default).
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  }), 8000, "gemini"), 3, 500);
  console.log(`[gemini] response in ${Date.now() - t0}ms, calls=${(res.functionCalls ?? []).length}`);

  const calls = res.functionCalls ?? [];
  const call = calls[0];
  if (!call || call.name !== "control_drone" || !call.args) {
    throw new Error("model did not return a control_drone call");
  }
  const args = call.args as Record<string, unknown>;
  const action = args["action"] as DroneAction | undefined;
  if (!action) throw new Error("control_drone call missing action");

  const command: DroneCommand = { action };
  if (typeof args["distance"] === "number") command.distance = args["distance"];
  if (typeof args["degree"] === "number") command.degree = args["degree"];
  if (args["dir"] === "l" || args["dir"] === "r" || args["dir"] === "f" || args["dir"] === "b") {
    command.dir = args["dir"];
  }

  const heard = typeof args["heard"] === "string" ? (args["heard"] as string) : undefined;
  return { command, raw: describe(command), heard };
}

/** Text-only connectivity probe: proves the container can reach Gemini and the
 * key/model work, isolating network/model issues from audio-specific ones. */
export async function pingText(): Promise<{ ok: boolean; ms: number; text?: string; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await withTimeout(
      getClient().models.generateContent({
        model: config.geminiModel,
        contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
        config: { temperature: 0, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
      }),
      12000,
      "gemini-ping",
    );
    return { ok: true, ms: Date.now() - t0, text: (res.text ?? "").slice(0, 40) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e as Error).message };
  }
}

/** Compact human description for UI echo. */
function describe(c: DroneCommand): string {
  switch (c.action) {
    case "up": case "down": case "left": case "right": case "forward": case "back":
      return `${c.action} ${c.distance ?? "?"}cm`;
    case "cw": case "ccw":
      return `${c.action} ${c.degree ?? "?"}°`;
    case "flip":
      return `flip ${c.dir ?? "?"}`;
    default:
      return c.action;
  }
}
