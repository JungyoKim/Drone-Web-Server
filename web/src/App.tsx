import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router";

import ConnectionHeader from "@/components/ConnectionHeader";
import CommandLog from "@/components/CommandLog";
import VoiceRecorder from "@/components/VoiceRecorder";
import ManualControls from "@/components/ManualControls";
import TrackingPanel from "@/components/TrackingPanel";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { useDroneSocket } from "@/hooks/useDroneSocket";

const NAV_LINKS = [
  { to: "/voice", label: "\uc74c\uc131 / \uc218\ub3d9" },
  { to: "/track", label: "\ub9c8\ucee4 \ucd94\uc801" },
] as const;

export default function App() {
  const ds = useDroneSocket();
  const controlsDisabled = !ds.state.deviceOnline;

  return (
    <BrowserRouter>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <ConnectionHeader
          connState={ds.state.connState}
          connLabel={ds.state.connLabel}
          deviceOnline={ds.state.deviceOnline}
          battery={ds.state.battery}
          token={ds.token}
          onTokenChange={ds.setToken}
          onConnect={ds.connect}
        />

        <nav className="flex gap-1 border-b border-border px-2 py-1.5">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto p-3">
          <Routes>
            <Route path="/" element={<Navigate to="/voice" replace />} />
            <Route
              path="/voice"
              element={
                <div className="flex flex-col gap-4">
                  <VoiceRecorder onAudio={ds.sendAudio} disabled={controlsDisabled} />
                  <ManualControls onCommand={ds.sendCommand} disabled={controlsDisabled} />
                </div>
              }
            />
            <Route
              path="/track"
              element={
                <TrackingPanel
                  tracking={ds.state.tracking}
                  deviceOnline={ds.state.deviceOnline}
                  onToggle={ds.setTrack}
                />
              }
            />
            <Route path="*" element={<Navigate to="/voice" replace />} />
          </Routes>
        </main>

        <div className="h-48 shrink-0 border-t border-border sm:h-56">
          <CommandLog log={ds.state.log} processing={ds.state.processing} />
        </div>
      </div>
      <Toaster theme="dark" position="top-center" />
    </BrowserRouter>
  );
}
