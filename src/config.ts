/** Runtime configuration from environment. */
export const config = {
  port: Number(Bun.env.PORT ?? 8080),
  /** Gemini API key. Required for voice; plumbing/tests run without it. */
  geminiApiKey: Bun.env.GEMINI_API_KEY ?? "",
  geminiModel: Bun.env.GEMINI_MODEL ?? "gemini-flash-lite-latest",
  /** Shared secret the ESP32 presents in its hello frame. */
  deviceToken: Bun.env.DEVICE_TOKEN ?? "dev-device-token",
  /** Bearer token the browser must present (?token=) to open /ws/browser. */
  browserToken: Bun.env.BROWSER_TOKEN ?? "dev-browser-token",
  /** Seconds to wait for a Tello reply relayed via the device before giving up. */
  commandTimeoutMs: Number(Bun.env.COMMAND_TIMEOUT_MS ?? 8000),

  // ---- ArUco marker-follow ----
  /** UDP port the backend listens on for the raw H.264 relay from the ESP32
   * (Tello's own UDP:11111 video, forwarded verbatim -- see firmware/README). */
  videoPort: Number(Bun.env.VIDEO_PORT ?? 8890),
  /** Tello's `streamon` output resolution (SDK default). Must match the ESP32
   * relay -- there's no negotiation, so a mismatch just decodes garbage. */
  videoWidth: Number(Bun.env.VIDEO_WIDTH ?? 960),
  videoHeight: Number(Bun.env.VIDEO_HEIGHT ?? 720),
  /** ArUco dictionary (see js-aruco2). ARUCO_MIP_36h12 is the modern default;
   * use "ARUCO" for the classic OpenCV 5x5 original dictionary. */
  arucoDictionary: Bun.env.ARUCO_DICTIONARY ?? "ARUCO_MIP_36h12",
  /** Track only this marker id; unset = follow whichever marker is seen. */
  arucoTargetId: Bun.env.ARUCO_TARGET_ID != null ? Number(Bun.env.ARUCO_TARGET_ID) : undefined,
  /** Apparent marker size (px, avg side length) that means "at the right
   * distance" -- bigger => drone thinks it's too close and backs off. Tune
   * empirically for your marker's real-world size + desired follow distance. */
  arucoTargetSizePx: Number(Bun.env.ARUCO_TARGET_SIZE_PX ?? 160),
  /** Safety clamp on every rc channel (-max..max, hard-capped to [-100,100]
   * regardless of gains below -- keeps tracking mode gentle by default). */
  trackMaxRc: Number(Bun.env.TRACK_MAX_RC ?? 35),
  /** Proportional gains: yaw from horizontal offset, throttle from vertical
   * offset, pitch from size-ratio (distance) error. */
  trackYawGain: Number(Bun.env.TRACK_YAW_GAIN ?? 60),
  trackAltGain: Number(Bun.env.TRACK_ALT_GAIN ?? 60),
  trackDistGain: Number(Bun.env.TRACK_DIST_GAIN ?? 80),

  // ---- Live camera preview (browser UI, independent of ArUco math) ----
  /** Preview output width in px; height auto-scales (ffmpeg `scale=W:-2`)
   * to preserve the source aspect ratio. Smaller = less bandwidth/CPU. */
  videoPreviewWidth: Number(Bun.env.VIDEO_PREVIEW_WIDTH ?? 480),
  /** ffmpeg `-q:v` for the preview MJPEG stream: 2 (best) .. 31 (worst). */
  videoPreviewQuality: Number(Bun.env.VIDEO_PREVIEW_QUALITY ?? 6),
  /** Upper bound on preview frames forwarded to browsers per second,
   * independent of ffmpeg's actual decode rate. */
  videoPreviewMaxFps: Number(Bun.env.VIDEO_PREVIEW_MAX_FPS ?? 12),
} as const;

export function assertVoiceConfigured(): void {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set; voice endpoint disabled");
  }
}
