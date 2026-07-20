import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface ConnectionHeaderProps {
  connState: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";
  connLabel: string;
  deviceOnline: boolean;
  battery: number | null;
  token: string;
  onTokenChange: (t: string) => void;
  onConnect: () => void;
}

/** Visual state driving the status dot color, mirroring the original `.dot`/`.dot.on|off|warn` CSS. */
type DotState = "on" | "off" | "warn" | "default";

const DOT_CLASSES: Record<DotState, string> = {
  on: "bg-emerald-500 shadow-[0_0_6px_var(--tw-shadow-color)] shadow-emerald-500",
  off: "bg-red-500",
  warn: "bg-amber-500",
  // "default": nothing has happened yet (idle) -- dim/grey, no glow, matches the original's un-classed `.dot`.
  default: "bg-muted-foreground/50",
};

function StatusDot({ state }: { state: DotState }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", DOT_CLASSES[state])}
    />
  );
}

/** Battery readout turns amber once the drone drops below this charge -- a low-battery visual nudge the original didn't have. */
const LOW_BATTERY_THRESHOLD = 20;

export default function ConnectionHeader({
  connState,
  connLabel,
  deviceOnline,
  battery,
  token,
  onTokenChange,
  onConnect,
}: ConnectionHeaderProps) {
  const connDotState: DotState =
    connState === "connected"
      ? "on"
      : connState === "connecting" || connState === "reconnecting"
        ? "warn"
        : connState === "disconnected"
          ? "off"
          : "default"; // idle: nothing attempted yet

  const deviceDotState: DotState = deviceOnline ? "on" : "off";
  const isLowBattery = battery !== null && battery < LOW_BATTERY_THRESHOLD;

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-card/95 px-3 py-2 backdrop-blur">
      <div className="mx-auto flex max-w-[560px] flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant="ghost" className="gap-1.5 border border-border px-2 py-1 text-xs">
          <StatusDot state={connDotState} />
          <span>{connLabel}</span>
        </Badge>

        <Badge variant="ghost" className="gap-1.5 border border-border px-2 py-1 text-xs">
          <StatusDot state={deviceDotState} />
          <span>{deviceOnline ? "드론 온라인" : "드론 오프라인"}</span>
          {battery !== null && (
            <span
              className={cn(
                "ml-0.5 tabular-nums",
                isLowBattery ? "font-semibold text-amber-500" : "text-muted-foreground"
              )}
            >
              🔋 {battery}%
            </span>
          )}
        </Badge>

        <div className="ml-auto flex min-w-[140px] flex-1 items-center gap-1.5 sm:flex-none">
          <Input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="브라우저 토큰"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConnect();
            }}
            className="h-7 min-w-0 flex-1 text-xs sm:w-32 sm:flex-none"
          />
          <Button size="sm" onClick={onConnect} className="shrink-0">
            연결
          </Button>
        </div>
      </div>
    </header>
  );
}
