import { Wifi, WifiOff, Radio, BatteryFull, BatteryLow, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemMedia, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import { cn } from "@/lib/utils";
import type { ConnState } from "@/hooks/useDroneSocket";

const LOW_BATTERY_THRESHOLD = 20;

interface ConnectionStatusBarProps {
  connState: ConnState;
  connLabel: string;
  deviceOnline: boolean;
  battery: number | null;
  onOpenConnectDialog: () => void;
}

const CONN_TONE: Record<ConnState, "ok" | "warn" | "off"> = {
  connected: "ok",
  connecting: "warn",
  reconnecting: "warn",
  idle: "off",
  disconnected: "off",
};

const TONE_CLASSES: Record<"ok" | "warn" | "off", string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  off: "text-muted-foreground",
};

/**
 * Backend + drone connection info, moved down here out of the header (which
 * now only carries the route tabs + emergency land). One row, always
 * visible above the command log, with a settings button that reopens the
 * connect dialog on demand -- the dialog itself only pops up automatically
 * (see App.tsx's auto-open effect), this is the manual escape hatch.
 */
export default function ConnectionStatusBar({
  connState,
  connLabel,
  deviceOnline,
  battery,
  onOpenConnectDialog,
}: ConnectionStatusBarProps) {
  const connTone = CONN_TONE[connState];
  const lowBattery = typeof battery === "number" && battery < LOW_BATTERY_THRESHOLD;

  return (
    <div className="flex items-center gap-1.5 border-t border-border bg-card/60 px-2 py-1.5">
      <Item variant="muted" size="xs" className="w-auto flex-1 basis-32">
        <ItemMedia>
          {connTone === "off" ? (
            <WifiOff className={cn("size-3.5", TONE_CLASSES[connTone])} />
          ) : (
            <Wifi className={cn("size-3.5", TONE_CLASSES[connTone])} />
          )}
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="text-xs">{connLabel}</ItemTitle>
          <ItemDescription className="text-[10px]">백엔드</ItemDescription>
        </ItemContent>
      </Item>

      <Item variant="muted" size="xs" className="w-auto flex-1 basis-32">
        <ItemMedia>
          <Radio className={cn("size-3.5", deviceOnline ? TONE_CLASSES.ok : TONE_CLASSES.off)} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="flex items-center gap-1 text-xs">
            <span>{deviceOnline ? "드론 온라인" : "드론 오프라인"}</span>
            {battery !== null && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-normal",
                  lowBattery && "font-semibold text-amber-500",
                )}
              >
                {lowBattery ? (
                  <BatteryLow className="size-3" />
                ) : (
                  <BatteryFull className="size-3" />
                )}
                {battery}%
              </span>
            )}
          </ItemTitle>
          <ItemDescription className="text-[10px]">드론</ItemDescription>
        </ItemContent>
      </Item>

      <ItemActions>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onOpenConnectDialog}
          aria-label="연결 설정"
        >
          <Settings2 className="size-4" />
        </Button>
      </ItemActions>
    </div>
  );
}
