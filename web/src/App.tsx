import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import AppHeader from "@/components/AppHeader";
import CommandLog from "@/components/CommandLog";
import VoiceRecorder from "@/components/VoiceRecorder";
import ManualControls from "@/components/ManualControls";
import TrackingPanel from "@/components/TrackingPanel";
import { Toaster } from "@/components/ui/sonner";
import { useDroneSocket } from "@/hooks/useDroneSocket";

export default function App() {
  const ds = useDroneSocket();
  const controlsDisabled = !ds.state.deviceOnline;

  return (
    <BrowserRouter>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <AppHeader
          connState={ds.state.connState}
          connLabel={ds.state.connLabel}
          deviceOnline={ds.state.deviceOnline}
          battery={ds.state.battery}
          token={ds.token}
          onTokenChange={ds.setToken}
          onConnect={ds.connect}
          onEmergencyLand={() => ds.sendCommand({ action: "land" })}
          emergencyDisabled={controlsDisabled}
        />

        <main className="min-h-0 flex-1 overflow-y-auto p-3">
          <Routes>
            <Route path="/" element={<Navigate to="/manual" replace />} />
            <Route
              path="/voice"
              element={<VoiceRecorder onAudio={ds.sendAudio} disabled={controlsDisabled} />}
            />
            <Route
              path="/manual"
              element={<ManualControls onCommand={ds.sendCommand} disabled={controlsDisabled} />}
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
            <Route path="*" element={<Navigate to="/manual" replace />} />
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
