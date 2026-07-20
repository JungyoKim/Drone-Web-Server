import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Mic } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface VoiceRecorderProps {
  /** base64 audio WITHOUT the "data:...;base64," prefix, plus its mime type. */
  onAudio: (audioBase64: string, mime: string) => void;
  /** e.g. when the device is offline -- renders inert but still visible. */
  disabled?: boolean;
}

type RecState = "idle" | "starting" | "recording";

function micSupported(): boolean {
  return !!(
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

/**
 * Large push-to-talk mic button. Faithful port of the original vanilla-JS
 * state machine (public/index.html ~L511-650, L807-830): press-and-hold via
 * pointer events (mouse + touch + pen), cached getUserMedia stream, abort if
 * released before the mic comes up, MediaRecorder chunk accumulation, and
 * FileReader base64 encoding on release.
 */
export default function VoiceRecorder({ onAudio, disabled = false }: VoiceRecorderProps) {
  const [recState, setRecState] = useState<RecState>("idle");
  // Mirrors recState synchronously for use inside async callbacks (getUserMedia
  // promise, MediaRecorder event handlers) where a stale closure over React
  // state would otherwise race the user's pointerup.
  const recStateRef = useRef<RecState>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const supportedRef = useRef(micSupported());
  const supported = supportedRef.current;

  const setState = useCallback((s: RecState) => {
    recStateRef.current = s;
    setRecState(s);
  }, []);

  // Cache the MediaStream so repeated presses don't re-prompt for permission.
  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    if (streamRef.current) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    return stream;
  }, []);

  const sendAudioBlob = useCallback(
    (blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        const b64 = comma >= 0 ? result.slice(comma + 1) : result;
        onAudio(b64, blob.type || "audio/webm");
      };
      reader.onerror = () => {
        toast.error("녹음을 읽지 못했습니다.");
      };
      reader.readAsDataURL(blob);
    },
    [onAudio]
  );

  const startRecording = useCallback(() => {
    if (recStateRef.current !== "idle") return;
    if (!supported) {
      toast.error("마이크를 사용할 수 없습니다. HTTPS와 지원되는 브라우저가 필요합니다.");
      return;
    }
    setState("starting");

    ensureStream()
      .then((stream) => {
        // Released before the mic came up? Abort cleanly, never record.
        if (recStateRef.current !== "starting") {
          setState("idle");
          return;
        }

        chunksRef.current = [];
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream);
        } catch {
          setState("idle");
          toast.error("이 브라우저는 녹음을 지원하지 않습니다.");
          return;
        }
        recorderRef.current = recorder;

        recorder.ondataavailable = (ev: BlobEvent) => {
          if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        recorder.onstop = () => {
          const chunks = chunksRef.current;
          const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
          const blob = new Blob(chunks, { type });
          chunksRef.current = [];
          setState("idle");
          if (blob.size === 0) {
            toast.error("녹음된 내용이 없습니다 — 조금 더 길게 누르세요.");
            return;
          }
          sendAudioBlob(blob);
        };
        recorder.onerror = (ev: ErrorEvent) => {
          setState("idle");
          const err: unknown = ev.error;
          const message = err instanceof Error || err instanceof DOMException ? err.message : "녹음 오류";
          toast.error(`녹음 오류: ${message}`);
        };

        try {
          recorder.start();
          setState("recording");
        } catch (e) {
          setState("idle");
          const msg = e instanceof Error ? e.message : String(e);
          toast.error(`녹음을 시작할 수 없습니다: ${msg}`);
        }
      })
      .catch((err: unknown) => {
        setState("idle");
        const name = err instanceof DOMException ? err.name : "";
        let msg: string;
        if (name === "NotAllowedError" || name === "SecurityError") {
          msg = "마이크 권한이 거부되었습니다. 마이크 접근을 허용하세요 (HTTPS 필요).";
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          msg = "이 기기에서 마이크를 찾을 수 없습니다.";
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          msg = `마이크를 사용할 수 없습니다: ${detail || name}. 보안(HTTPS) 컨텍스트와 마이크 권한이 필요합니다.`;
        }
        toast.error(msg);
      });
  }, [ensureStream, sendAudioBlob, setState, supported]);

  const stopRecording = useCallback(() => {
    if (recStateRef.current === "starting") {
      // Released before the stream came up -- cancel.
      setState("idle");
      return;
    }
    if (recStateRef.current === "recording" && recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        setState("idle");
      }
    }
  }, [setState]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      if (disabled) return;
      if (!supported) {
        toast.error("마이크를 사용할 수 없습니다. HTTPS와 지원되는 브라우저가 필요합니다.");
        return;
      }
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore -- capture is best-effort
      }
      startRecording();
    },
    [disabled, supported, startRecording]
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      stopRecording();
    },
    [stopRecording]
  );

  const handlePointerCancel = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  // Safety net: if the pointer leaves without a proper capture release
  // (older engines), stop recording rather than leaving the mic hot.
  const handlePointerLeave = useCallback(() => {
    if (recStateRef.current === "recording" || recStateRef.current === "starting") {
      stopRecording();
    }
  }, [stopRecording]);

  // Block the browser's long-press context menu from interrupting the hold gesture.
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
  }, []);

  // Unmount cleanup: stop any active recorder and all tracks on any cached stream.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // ignore
          }
        }
      }
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const isRecording = recState === "recording";
  const isStarting = recState === "starting";
  const isInert = disabled || !supported;

  const label = !supported
    ? "🎤 마이크 사용 불가"
    : isRecording
      ? "● 녹음 중…"
      : isStarting
        ? "… 시작 중"
        : "🎤 눌러서 말하기";

  const sub = !supported
    ? "HTTPS + 마이크 권한 필요"
    : isRecording
      ? "떼면 전송"
      : isStarting
        ? ""
        : "누른 채로 말하고, 떼면 전송";

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={isInert}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onContextMenu={handleContextMenu}
        aria-pressed={isRecording}
        aria-label={label}
        className={cn(
          "size-28 touch-none rounded-full border-2 p-0 transition-all select-none",
          isRecording &&
            "animate-pulse border-destructive bg-destructive/20 text-destructive shadow-[0_0_0_4px_color-mix(in_oklch,var(--destructive)_30%,transparent),0_0_24px_color-mix(in_oklch,var(--destructive)_45%,transparent)] hover:bg-destructive/20",
          isStarting && "opacity-70",
          !isRecording && !isStarting && "border-primary text-primary"
        )}
      >
        <Mic className="size-12" />
      </Button>
      <div className="text-center">
        <div className="text-sm font-medium">{label}</div>
        {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
      </div>
    </div>
  );
}
