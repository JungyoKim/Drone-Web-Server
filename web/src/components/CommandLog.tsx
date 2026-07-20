import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface LogEntry {
  id: number
  ts: number
  kind: "info" | "sent" | "ok" | "fail" | "err"
  text: string
}

interface CommandLogProps {
  /** newest LAST (append order); already capped upstream, just render in order */
  log: LogEntry[]
  /** show a "인식 중···" (animated ellipsis) line at the bottom while true */
  processing: boolean
}

const NEAR_BOTTOM_PX = 24

const kindClass: Record<LogEntry["kind"], string> = {
  info: "text-muted-foreground",
  sent: "text-blue-400",
  ok: "text-green-400",
  fail: "text-destructive",
  err: "text-destructive",
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

export default function CommandLog({ log, processing }: CommandLogProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)

  // Cycling "." -> ".." -> "..." indicator while processing.
  const [dotCount, setDotCount] = useState(1)
  useEffect(() => {
    if (!processing) return
    setDotCount(1)
    const timer = setInterval(() => {
      setDotCount((n) => (n % 3) + 1)
    }, 350)
    return () => clearInterval(timer)
  }, [processing])

  const getViewport = () =>
    containerRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    ) ?? null

  // Track whether the user is scrolled near the bottom so new lines don't
  // yank them back down if they scrolled up to read history.
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return
    const onScroll = () => {
      wasAtBottomRef.current =
        viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - NEAR_BOTTOM_PX
    }
    onScroll()
    viewport.addEventListener("scroll", onScroll, { passive: true })
    return () => viewport.removeEventListener("scroll", onScroll)
  }, [])

  // Auto-scroll to bottom on new log lines or when the processing indicator
  // appears/disappears -- but only if the user was already near the bottom.
  useLayoutEffect(() => {
    const viewport = getViewport()
    if (!viewport) return
    if (wasAtBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [log, processing])

  const isEmpty = log.length === 0 && !processing

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea ref={containerRef} className="min-h-0 flex-1">
        <div className="select-text px-1 py-1">
          {isEmpty ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              로그 없음
            </div>
          ) : (
            <>
              {log.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    "border-b border-border/50 px-1 py-[3px] text-sm whitespace-pre-wrap break-words",
                    kindClass[entry.kind]
                  )}
                >
                  <span className="opacity-60">{fmtTime(entry.ts)}</span>{" "}
                  {entry.text}
                </div>
              ))}
              {processing && (
                <div className="border-b border-border/50 px-1 py-[3px] text-sm text-muted-foreground opacity-70">
                  <span className="opacity-60">{fmtTime(Date.now())}</span>{" "}
                  🧠 인식 중<span className="inline-block w-6">{".".repeat(dotCount)}</span>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
