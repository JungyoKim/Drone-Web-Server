/** Runtime configuration from environment. */
export const config = {
  port: Number(Bun.env.PORT ?? 8080),
  /** Gemini API key. Required for voice; plumbing/tests run without it. */
  geminiApiKey: Bun.env.GEMINI_API_KEY ?? "",
  geminiModel: Bun.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  /** Shared secret the ESP32 presents in its hello frame. */
  deviceToken: Bun.env.DEVICE_TOKEN ?? "dev-device-token",
  /** Bearer token the browser must present (?token=) to open /ws/browser. */
  browserToken: Bun.env.BROWSER_TOKEN ?? "dev-browser-token",
  /** Seconds to wait for a Tello reply relayed via the device before giving up. */
  commandTimeoutMs: Number(Bun.env.COMMAND_TIMEOUT_MS ?? 8000),
} as const;

export function assertVoiceConfigured(): void {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set; voice endpoint disabled");
  }
}
