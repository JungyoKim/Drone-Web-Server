import { useLocation, useNavigate } from "react-router";
import { Wifi, WifiOff, Radio, BatteryFull, BatteryLow, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle, ItemDescription } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { ConnState } from "@/hooks/useDroneSocket";

const LOW_BATTERY_THRESHOLD = 20;

const NAV_LINKS = [
  { to: "/manual", label: "수동" },
  { to: "/voice", label: "음성" },
  { to: "/track", label: "마커 추적" },
] as const;

interface AppHeaderProps {
  connState: ConnState;
  connLabel: string;
  deviceOnline: boolean;
  battery: number | null;
  token: string;
  onTokenChange: (t: string) => void;
  onConnect: () => void;
  onEmergencyLand: () => void;
  emergencyDisabled: boolean;
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
 * Single cohesive header block: connection/device status, the token+connect
 * control, a persistent emergency-land bar (visible on every route -- the
 * safety button should never require navigating to a specific tab), and the
 * route tabs. One bordered container, one visual rhythm, instead of three
 * separately-styled strips.
 */
export default function AppHeader({
  connState,
  connLabel,
  deviceOnline,
  battery,
  token,
  onTokenChange,
  onConnect,
  onEmergencyLand,
  emergencyDisabled,
}: AppHeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const connTone = CONN_TONE[connState];
  const lowBattery = typeof battery === "number" && battery < LOW_BATTERY_THRESHOLD;

  return (
    <header className="sticky top-0 z-50 flex flex-col gap-2.5 border-b border-border bg-card/95 px-3 py-2.5 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <Item variant="muted" size="sm" className="w-auto flex-1 basis-40">
          <ItemMedia>
            {connTone === "off" ? (
              <WifiOff className={cn("size-4", TONE_CLASSES[connTone])} />
            ) : (
              <Wifi className={cn("size-4", TONE_CLASSES[connTone])} />
            )}
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{connLabel}</ItemTitle>
            <ItemDescription>백엔드</ItemDescription>
          </ItemContent>
        </Item>

        <Item variant="muted" size="sm" className="w-auto flex-1 basis-40">
          <ItemMedia>
            <Radio className={cn("size-4", deviceOnline ? TONE_CLASSES.ok : TONE_CLASSES.off)} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{deviceOnline ? "드론 온라인" : "드론 오프라인"}</ItemTitle>
            {battery !== null && (
              <ItemDescription className={cn(lowBattery && "font-semibold text-amber-500")}>
                {lowBattery ? (
                  <BatteryLow className="inline size-3.5 align-[-2px]" />
                ) : (
                  <BatteryFull className="inline size-3.5 align-[-2px]" />
                )}{" "}
                {battery}%
              </ItemDescription>
            )}
          </ItemContent>
        </Item>

        <div className="flex items-center gap-1.5">
          <Input
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConnect();
            }}
            placeholder="브라우저 토큰"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-8 w-28 text-xs"
          />
          <Button size="sm" onClick={onConnect}>
            연결
          </Button>
        </div>
      </div>

      <Separator />

      <Button
        variant="destructive"
        onClick={onEmergencyLand}
        isDisabled={emergencyDisabled}
        className="h-auto w-full flex-col gap-0.5 whitespace-normal bg-destructive py-1.5 text-base font-extrabold uppercase tracking-wider text-white hover:bg-destructive/90"
      >
        <span className="flex items-center gap-2">
          <TriangleAlert className="size-5" />
          비상 착륙
        </span>
        <small className="block text-[10px] font-semibold normal-case tracking-normal opacity-85">
          눌러서 즉시 착륙 · 하드웨어 버튼이 진짜 최후 수단
        </small>
      </Button>

      <Tabs
        selectedKey={location.pathname}
        onSelectionChange={(key) => navigate(String(key))}
      >
        <TabsList className="w-full">
          {NAV_LINKS.map((link) => (
            <TabsTrigger key={link.to} id={link.to} className="flex-1">
              {link.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </header>
  );
}
