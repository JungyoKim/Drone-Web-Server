import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TrackingState } from "@/hooks/useDroneSocket";

interface TrackingPanelProps {
  tracking: TrackingState;
  deviceOnline: boolean;
  onToggle: (on: boolean) => void;
  /** Subscribes to live camera preview frames (base64 JPEG, no `data:`
   * prefix); returns an unsubscribe function. Frames are pushed
   * imperatively straight onto the <img> element (bypassing React state),
   * so a ~10fps video feed never re-renders anything outside this
   * component -- see useDroneSocket's onFrame. */
  onFrame: (cb: (jpegBase64: string) => void) => () => void;
}

/**
 * Clamp a dx/dy component to [-1, 1] for percentage mapping. Mirrors the
 * original `clampUnit` in public/index.html exactly, including its
 * not-a-number fallback of 0.5 (rather than 0).
 */
function clampUnit(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0.5;
  if (n < -1) return -1;
  if (n > 1) return 1;
  return n;
}

export default function TrackingPanel({ tracking, deviceOnline, onToggle, onFrame }: TrackingPanelProps) {
  const { active, markerFound, markerId, dx, dy } = tracking;
  const imgRef = useRef<HTMLImageElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  // Subscribe once for the component's lifetime; the callback itself never
  // touches React state on the hot path (only the one-time hasFrame flip).
  useEffect(() => {
    return onFrame((jpegBase64) => {
      if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${jpegBase64}`;
      setHasFrame((prev) => (prev ? prev : true));
    });
  }, [onFrame]);

  // Tracking stopped (or the drone/session dropped) -- the last frame is
  // now stale. Fall back to the placeholder rather than showing a frozen
  // image next time tracking starts.
  useEffect(() => {
    if (!active) setHasFrame(false);
  }, [active]);

  const dotLeft = `${((clampUnit(dx) + 1) / 2) * 100}%`;
  const dotTop = `${((clampUnit(dy) + 1) / 2) * 100}%`;

  const found = active && markerFound;
  const searching = active && !markerFound;

  const statusText = active ? (markerFound ? "마커 발견" : "마커 상실") : "대기 중";
  const statusDotClass = found ? "bg-emerald-500" : searching ? "bg-amber-500" : "bg-muted-foreground/40";

  return (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            variant={active ? "destructive" : "default"}
            size="lg"
            className="flex-1"
            isDisabled={!deviceOnline}
            onClick={() => onToggle(!active)}
          >
            {active ? "마커 추적 중지" : "마커 추적 시작"}
          </Button>
          <Badge variant="ghost" className="gap-1.5">
            <span className={cn("size-2 rounded-full", active ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            <span>{active ? "추적 켜짐" : "추적 꺼짐"}</span>
          </Badge>
        </div>

        <div className="relative overflow-hidden rounded-md bg-muted">
          {/* Always mounted (never unmounted) so imgRef stays stable across
              frames; `hidden` keeps a src-less <img> from painting a broken-
              image icon before the first frame arrives. */}
          <img ref={imgRef} alt="" className={cn("block h-auto w-full", !hasFrame && "hidden")} />
          {!hasFrame && (
            <div className="flex aspect-[4/3] w-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
              {active ? "영상 연결 중\u2026" : "추적을 시작하면 실시간 영상이 표시됩니다"}
            </div>
          )}
          <div
            className={cn(
              "absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white transition-[opacity,left,top] duration-150",
              found ? "bg-emerald-500 opacity-100 shadow-[0_0_8px_theme(colors.emerald.500)]" : "opacity-0",
            )}
            style={{ left: dotLeft, top: dotTop }}
          />
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", statusDotClass)} />
          <span>{statusText}</span>
          {active && markerFound && typeof markerId === "number" ? <span>&middot; ID: {markerId}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
