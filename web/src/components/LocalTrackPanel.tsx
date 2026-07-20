import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { LocalTrackState } from "@/hooks/useLocalTrack";

interface LocalTrackPanelProps {
  state: LocalTrackState;
  host: string;
  onHostChange: (h: string) => void;
  token: string;
  onTokenChange: (t: string) => void;
  active: boolean;
  onToggle: (on: boolean) => void;
  /** Subscribes to live decoded video frames (each callback receives the
   * hook's internal canvas, already painted); returns an unsubscribe
   * function -- see useLocalTrack's onFrame. Mirrors TrackingPanel's onFrame
   * prop exactly, just with a canvas payload instead of a base64 JPEG. */
  onFrame: (cb: (canvas: HTMLCanvasElement) => void) => () => void;
}

/** Clamp a dx/dy component to [-1, 1] for percentage mapping. Same
 * behavior as TrackingPanel's clampUnit (kept as a separate copy since
 * that one lives in a different component file with no shared home for
 * such a tiny UI-only helper). */
function clampUnit(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0.5;
  if (n < -1) return -1;
  if (n > 1) return 1;
  return n;
}

/**
 * UI for the local (phone<->ESP32 direct) tracking data plane -- host/token
 * entry, connect/disconnect, the live decoded video, and telemetry
 * (marker found, dx/dy/sizeRatio, rc channels), mirroring TrackingPanel's
 * layout so the two tracking modes feel like the same feature. This is a
 * SEPARATE mode from the cloud `/track` tab (see local-track-protocol.md):
 * both can run at once, but this one talks straight to the ESP32 over the
 * phone's hotspot LAN instead of round-tripping through the backend.
 */
export default function LocalTrackPanel({
  state,
  host,
  onHostChange,
  token,
  onTokenChange,
  active,
  onToggle,
  onFrame,
}: LocalTrackPanelProps) {
  const { connState, connLabel, telemetry } = state;
  const { markerFound, markerId, dx, dy, sizeRatio, rc } = telemetry;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  // Subscribe once for the component's lifetime; the callback itself never
  // touches React state on the hot path (only the one-time hasFrame flip) --
  // mirrors TrackingPanel's onFrame subscription exactly.
  useEffect(() => {
    return onFrame((srcCanvas) => {
      const dst = canvasRef.current;
      if (dst) dst.getContext("2d")?.drawImage(srcCanvas, 0, 0, dst.width, dst.height);
      setHasFrame((prev) => (prev ? prev : true));
    });
  }, [onFrame]);

  // Disconnected -- the last painted frame is now stale. Fall back to the
  // placeholder rather than showing a frozen image on the next connect.
  useEffect(() => {
    if (connState !== "connected") setHasFrame(false);
  }, [connState]);

  const editable = connState === "idle" || connState === "disconnected" || connState === "error";
  const dotLeft = `${((clampUnit(dx) + 1) / 2) * 100}%`;
  const dotTop = `${((clampUnit(dy) + 1) / 2) * 100}%`;

  const found = active && markerFound;
  const searching = active && connState === "connected" && !markerFound;
  const statusText = !active ? "대기 중" : connState === "connected" ? (markerFound ? "마커 발견" : "마커 상실") : connLabel;
  const statusDotClass = found ? "bg-emerald-500" : searching ? "bg-amber-500" : "bg-muted-foreground/40";

  return (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex-1 text-sm font-medium">로컬 추적 (핫스팟 직결)</div>
          <Badge variant="ghost" className="gap-1.5">
            <span className={cn("size-2 rounded-full", connState === "connected" ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            <span>{connLabel}</span>
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="localTrackHost">ESP32 주소</Label>
            <Input
              id="localTrackHost"
              value={host}
              onChange={(e) => onHostChange(e.target.value)}
              placeholder="tello.local"
              disabled={!editable}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="localTrackToken">기기 토큰</Label>
            <Input
              id="localTrackToken"
              type="password"
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              placeholder="cfgToken"
              disabled={!editable}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </div>

        <Button
          type="button"
          variant={active ? "destructive" : "default"}
          size="lg"
          isDisabled={editable && token.trim().length === 0 && !active}
          onClick={() => onToggle(!active)}
        >
          {active ? "로컬 추적 중지" : "로컬 추적 시작"}
        </Button>

        <div className="relative overflow-hidden rounded-md bg-muted">
          {/* Always mounted so canvasRef stays stable across frames; `hidden`
              keeps a blank canvas from painting before the first frame. */}
          <canvas
            ref={canvasRef}
            width={960}
            height={720}
            className={cn("block h-auto w-full", !hasFrame && "hidden")}
          />
          {!hasFrame && (
            <div className="flex aspect-[4/3] w-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
              {active ? "영상 연결 중\u2026" : "로컬 추적을 시작하면 실시간 영상이 표시됩니다"}
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
          {found && typeof markerId === "number" ? <span>&middot; ID: {markerId}</span> : null}
        </div>

        {active && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-2.5 font-mono text-[11px] text-muted-foreground">
            <span>dx: {dx.toFixed(3)}</span>
            <span>dy: {dy.toFixed(3)}</span>
            <span>size: {sizeRatio != null ? sizeRatio.toFixed(3) : "-"}</span>
            <span>
              rc: {rc.a} {rc.b} {rc.c} {rc.d}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
