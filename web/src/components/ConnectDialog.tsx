import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnState } from "@/hooks/useDroneSocket";

interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  onTokenChange: (t: string) => void;
  onConnect: () => void;
  connState: ConnState;
}

/**
 * Token entry, as a dialog instead of a permanent header input. App.tsx
 * decides WHEN this auto-opens (no saved token, or a stable disconnect e.g.
 * a rejected token) -- this component only renders it and handles the
 * connect action, closing itself once the connection succeeds.
 */
export default function ConnectDialog({
  open,
  onOpenChange,
  token,
  onTokenChange,
  onConnect,
  connState,
}: ConnectDialogProps) {
  const [draft, setDraft] = useState(token);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the draft to the latest saved token whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setDraft(token);
      // Autofocus shortly after the open animation starts.
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open, token]);

  function submit() {
    onTokenChange(draft);
    onConnect();
  }

  const busy = connState === "connecting" || connState === "reconnecting";

  return (
    <Dialog isOpen={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>백엔드 연결</DialogTitle>
        <DialogDescription>
          브라우저 토큰을 입력하면 저장되어 다음에는 자동으로 연결됩니다.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5 py-2">
        <Label htmlFor="tokenDialogInput">토큰</Label>
        <Input
          id="tokenDialogInput"
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="브라우저 토큰"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      <DialogFooter>
        <Button onClick={submit} isDisabled={draft.trim().length === 0} className="w-full">
          {busy ? "연결 중…" : "연결"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
