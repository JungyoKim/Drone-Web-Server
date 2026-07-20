import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import AppHeader from "@/components/AppHeader";
import ConnectDialog from "@/components/ConnectDialog";
import ConnectionStatusBar from "@/components/ConnectionStatusBar";
import CommandLog from "@/components/CommandLog";
import VoiceRecorder from "@/components/VoiceRecorder";
import ManualControls from "@/components/ManualControls";
import TrackingPanel from "@/components/TrackingPanel";
import LocalTrackPanel from "@/components/LocalTrackPanel";
import MarkerDesigner from "@/components/MarkerDesigner";
import { Toaster } from "@/components/ui/sonner";
import { useDroneSocket } from "@/hooks/useDroneSocket";
import { useLocalTrack } from "@/hooks/useLocalTrack";

export default function App() {
  const ds = useDroneSocket();
  // Independent of the cloud connection above -- both hooks run
  // simultaneously, per local-track-protocol.md. Fed the cloud's
  // markerPattern/isFlying so the local detector reuses the same
  // dictionary and never streams movement while the drone isn't airborne.
  // onStreamToggle sends a plain one-off streamon/streamoff over the CLOUD
  // connection (NOT setTrack -- that would also start the cloud's own
  // ffmpeg/rc tracking loop, racing this one) since Tello only emits video
  // after an explicit streamon and the local WS channel carries no command
  // traffic besides `rc` by design.
  const lt = useLocalTrack({
    markerPattern: ds.state.markerPattern,
    isFlying: ds.state.isFlying,
    onStreamToggle: (on) => ds.sendCommand({ action: on ? "streamon" : "streamoff" }),
  });
  const controlsDisabled = !ds.state.deviceOnline;

  // Auto-open the connect dialog when there's no saved token (first visit --
  // starts true), otherwise once per "not working" episode: either we've
  // never successfully connected yet this session (a bad/rejected token --
  // note the browser endpoint 401s a bad token at the HTTP upgrade, closing
  // with code 1006, so it can loop through "reconnecting" forever without
  // ever settling on "disconnected"; `everConnected` is what actually
  // distinguishes that from a healthy retry), or we just DROPPED from a
  // working connection. Fires once per episode (not on every retry tick) so
  // dismissing it doesn't get immediately fought; a fresh success resets it.
  const [dialogOpen, setDialogOpen] = useState(!ds.token);
  const prevConnStateRef = useRef(ds.state.connState);
  const promptedThisEpisodeRef = useRef(false);
  useEffect(() => {
    const prev = prevConnStateRef.current;
    prevConnStateRef.current = ds.state.connState;

    if (ds.state.connState === "connected") {
      setDialogOpen(false);
      promptedThisEpisodeRef.current = false;
      return;
    }

    const failing = ds.state.connState === "disconnected" || ds.state.connState === "reconnecting";
    const justDropped = prev === "connected" && failing;
    const neverWorkedYet = !ds.state.everConnected && failing;
    if ((justDropped || neverWorkedYet) && !promptedThisEpisodeRef.current) {
      setDialogOpen(true);
      promptedThisEpisodeRef.current = true;
    }
  }, [ds.state.connState, ds.state.everConnected]);

  return (
    <BrowserRouter>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <AppHeader
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
                  onFrame={ds.onFrame}
                />
              }
            />
            <Route
              path="/track-local"
              element={
                <LocalTrackPanel
                  state={lt.state}
                  host={lt.host}
                  onHostChange={lt.setHost}
                  token={lt.token}
                  onTokenChange={lt.setToken}
                  active={lt.active}
                  onToggle={lt.setActive}
                  onFrame={lt.onFrame}
                />
              }
            />
            <Route
              path="/marker"
              element={
                <MarkerDesigner
                  activePattern={ds.state.markerPattern}
                  onApply={ds.applyMarkerPattern}
                  onClear={ds.clearMarkerPattern}
                />
              }
            />
            <Route path="*" element={<Navigate to="/manual" replace />} />
          </Routes>
        </main>

        <ConnectionStatusBar
          connState={ds.state.connState}
          connLabel={ds.state.connLabel}
          deviceOnline={ds.state.deviceOnline}
          battery={ds.state.battery}
          onOpenConnectDialog={() => setDialogOpen(true)}
        />

        <div className="h-40 shrink-0 border-t border-border sm:h-48">
          <CommandLog log={ds.state.log} processing={ds.state.processing} />
        </div>
      </div>

      <ConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        token={ds.token}
        onTokenChange={ds.setToken}
        onConnect={ds.connect}
        connState={ds.state.connState}
      />
      <Toaster theme="dark" position="top-center" />
    </BrowserRouter>
  );
}
