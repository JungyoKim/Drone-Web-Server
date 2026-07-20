import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TrackingState } from "@/hooks/useDroneSocket";

interface TrackingPanelProps {
  tracking: TrackingState;
  deviceOnline: boolean;
  onToggle: (on: boolean) => void;
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

export default function TrackingPanel({ tracking, deviceOnline, onToggle }: TrackingPanelProps) {
  const { active, markerFound, markerId, dx, dy } = tracking;

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

        <div className="flex items-center gap-3.5">
          <div
            className="relative shrink-0 overflow-hidden rounded-md bg-muted"
            style={{ width: 80, height: 80 }}
          >
            <div
              className={cn(
                "absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[opacity,left,top] duration-150",
                found ? "bg-emerald-500 opacity-100 shadow-[0_0_6px_theme(colors.emerald.500)]" : "opacity-0"
              )}
              style={{ left: dotLeft, top: dotTop }}
            />
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", statusDotClass)} />
              <span>{statusText}</span>
            </div>
            {active && markerFound && typeof markerId === "number" ? (
              <div>ID: {markerId}</div>
            ) : (
              <div>&mdash;</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
