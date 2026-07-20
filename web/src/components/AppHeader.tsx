import { useLocation, useNavigate } from "react-router";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const NAV_LINKS = [
  { to: "/manual", label: "수동" },
  { to: "/voice", label: "음성" },
  { to: "/track", label: "마커 추적" },
] as const;

interface AppHeaderProps {
  onEmergencyLand: () => void;
  emergencyDisabled: boolean;
}

/**
 * Minimal top chrome: route tabs, then the emergency-land bar right below
 * them -- persistent across all 3 routes (manual/voice/track), not just
 * reachable from the manual tab. Connection/device status lives at the
 * bottom of the app now (see ConnectionStatusBar), out of the way of the
 * two things that matter most up top: where you are, and the panic button.
 */
export default function AppHeader({ onEmergencyLand, emergencyDisabled }: AppHeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-50 flex flex-col gap-2 border-b border-border bg-card/95 px-3 py-2 backdrop-blur">
      <Tabs selectedKey={location.pathname} onSelectionChange={(key) => navigate(String(key))}>
        <TabsList className="w-full">
          {NAV_LINKS.map((link) => (
            <TabsTrigger key={link.to} id={link.to} className="flex-1">
              {link.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Button
        variant="destructive"
        onClick={onEmergencyLand}
        isDisabled={emergencyDisabled}
        className="h-10 w-full bg-destructive text-base font-extrabold uppercase tracking-wider text-white hover:bg-destructive/90"
      >
        <TriangleAlert className="size-5" />
        비상 착륙
      </Button>
    </header>
  );
}
