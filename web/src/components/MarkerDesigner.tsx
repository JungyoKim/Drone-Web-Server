import { useMemo, useState } from "react";
import { Printer, Download, Check, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MARKER_GRID_SIZE, MARKER_BITS, emptyMarkerPattern, generateMarkerSvg, toggleCell } from "@/lib/markerSvg";

interface MarkerDesignerProps {
  /** Currently active pattern on the backend, or null if using the default
   * dictionary. Source of truth -- kept in sync across every open browser
   * tab (see useDroneSocket's marker_pattern handling). */
  activePattern: boolean[] | null;
  onApply: (pattern: boolean[]) => void;
  onClear: () => void;
}

/** data: URL for a generated marker SVG -- lets a plain <img> render it (and
 * be the thing actually printed/downloaded) without dangerouslySetInnerHTML. */
function svgDataUrl(pattern: boolean[]): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(generateMarkerSvg(pattern))}`;
}

export default function MarkerDesigner({ activePattern, onApply, onClear }: MarkerDesignerProps) {
  // Local draft the user is editing. Seeded once from whatever's active on
  // the backend at mount time; deliberately NOT re-synced on every
  // activePattern change afterward, so a live update from another browser
  // tab never clobbers an in-progress local edit.
  const [pattern, setPattern] = useState<boolean[]>(() => activePattern ?? emptyMarkerPattern());

  const previewUrl = useMemo(() => svgDataUrl(pattern), [pattern]);
  const isDirty = useMemo(
    () => activePattern === null || pattern.some((cell, i) => cell !== activePattern[i]),
    [pattern, activePattern],
  );

  function handlePrint(): void {
    const win = window.open("", "_blank", "width=420,height=520");
    if (!win) return;
    win.document.write(
      `<!doctype html><html><head><title>마커 인쇄</title><style>` +
        `body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}` +
        `img{width:80mm;height:80mm;}` +
        `@media print{body{height:auto;}}` +
        `</style></head><body><img src="${svgDataUrl(pattern)}" alt="마커"/></body></html>`,
    );
    win.document.close();
    win.focus();
    win.onload = () => win.print();
  }

  function handleDownload(): void {
    const blob = new Blob([generateMarkerSvg(pattern)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "marker.svg";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex-1 text-sm font-medium">4x4 커스텀 마커 만들기</div>
          <Badge variant="ghost" className="gap-1.5">
            <span className={cn("size-2 rounded-full", activePattern ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            <span>{activePattern ? "커스텀 적용됨" : "기본 딕셔너리"}</span>
          </Badge>
        </div>

        <div className="flex items-start gap-4">
          {/* 4x4 clickable grid -- these buttons ARE the marker's data bits. */}
          <div
            className="grid shrink-0 gap-1 rounded-md bg-black p-2"
            style={{ gridTemplateColumns: `repeat(${MARKER_GRID_SIZE}, 1fr)` }}
          >
            {pattern.map((cell, i) => (
              <button
                key={i}
                type="button"
                aria-label={`셀 ${i}`}
                onClick={() => setPattern((p) => toggleCell(p, i))}
                className={cn(
                  "size-10 rounded-sm border border-white/10 transition-colors",
                  cell ? "bg-white" : "bg-black hover:bg-white/10",
                )}
              />
            ))}
          </div>

          {/* Print-accurate preview -- the exact bytes handPrint/handDownload emit. */}
          <div className="flex flex-1 flex-col items-center gap-2">
            <img src={previewUrl} alt="마커 미리보기" className="w-28 rounded-sm border border-border" />
            <div className="text-center text-[11px] leading-tight text-muted-foreground">
              흰 칸을 클릭해서 패턴을 그려보세요.
              <br />
              검은 테두리는 자동으로 붙어요.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="default" isDisabled={!isDirty} onClick={() => onApply(pattern)} className="gap-1.5">
            <Check className="size-4" />이 마커 추적하기
          </Button>
          <Button
            type="button"
            variant="outline"
            isDisabled={!activePattern}
            onClick={onClear}
            className="gap-1.5"
          >
            <X className="size-4" />
            기본으로 복귀
          </Button>
          <Button type="button" variant="outline" onClick={() => setPattern(emptyMarkerPattern())} className="gap-1.5">
            <RotateCcw className="size-4" />
            초기화
          </Button>
          <Button type="button" variant="outline" onClick={handlePrint} className="gap-1.5">
            <Printer className="size-4" />
            인쇄
          </Button>
        </div>
        <Button type="button" variant="ghost" onClick={handleDownload} className="gap-1.5">
          <Download className="size-4" />
          SVG 다운로드
        </Button>

        <div className="text-[11px] leading-relaxed text-muted-foreground">
          인쇄한 마커를 실제 크기(80mm)로 출력해서 드론이 따라갈 대상에 붙이세요. "이 마커 추적하기"를 누르면
          다음 추적 시작부터 이 패턴만 인식합니다 ({MARKER_BITS}비트, 회전 무관하게 인식돼요).
        </div>
      </CardContent>
    </Card>
  );
}
