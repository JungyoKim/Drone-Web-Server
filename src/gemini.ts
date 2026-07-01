import { GoogleGenAI, Type, FunctionCallingConfigMode } from "@google/genai";
import { config } from "./config.ts";
import type { DroneCommand, DroneAction } from "./protocol.ts";

/** Lazily constructed so plumbing/tests don't require a key. */
let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
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
        },
        required: ["action"],
      },
    },
  ],
};

const SYSTEM_INSTRUCTION = `You translate a Korean (or English) spoken drone instruction into exactly one control_drone function call.
Rules:
- Always call control_drone exactly once. Never answer in text.
- Map natural language to actions: 이륙/뜨다=takeoff, 착륙/내려=land, 정지/비상=emergency, 앞으로=forward, 뒤로=back, 위로=up, 아래로=down, 왼쪽=left, 오른쪽=right, 시계방향/우회전=cw, 반시계/좌회전=ccw, 뒤집기/플립=flip, 배터리=battery.
- Convert units to the required ones: meters->centimeters (1미터=100). If a movement distance is unspecified, use 50. If a rotation degree is unspecified, use 90.
- Clamp intent to valid ranges: distance 20-500cm, degree 1-360. If the user asks beyond a range, pick the nearest valid value.`;

export interface ParseResult {
  command: DroneCommand;
  /** Human-readable transcript/echo of what was understood, for the UI. */
  raw: string;
}

/**
 * Send recorded audio to Gemini and get back one structured drone command via
 * function calling. Throws on no/invalid function call so the caller surfaces an error.
 */
export async function parseAudioCommand(audioBase64: string, mime: string): Promise<ParseResult> {
  const res = await getClient().models.generateContent({
    model: config.geminiModel,
    contents: [
      {
        role: "user",
        parts: [
          { text: "Here is the spoken instruction. Produce one control_drone call." },
          { inlineData: { mimeType: mime, data: audioBase64 } },
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
    },
  });

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

  return { command, raw: describe(command) };
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
