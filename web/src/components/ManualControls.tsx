import { useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  RotateCcw,
  PlaneTakeoff,
  PlaneLanding,
  BatteryMedium,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { LIMITS, type DroneCommand } from "@/lib/ws-protocol";

interface ManualControlsProps {
  onCommand: (command: DroneCommand) => void;
  disabled?: boolean;
}

const DIST_MIN = LIMITS.distanceCm.min;
const DIST_MAX = LIMITS.distanceCm.max;
const DIST_STEP = 10;
const DIST_DEFAULT = 50;

const DEG_MIN = LIMITS.degree.min;
const DEG_MAX = LIMITS.degree.max;
const DEG_STEP = 5;
const DEG_DEFAULT = 90;

function clampInt(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/** Local hook mirroring the original page's `syncPair(numEl, rangeEl, min, max)`:
 * the number input mirrors freely while typing, and is clamped (in sync with
 * the slider) on blur / Enter. The slider always drives an already-clamped
 * value directly. */
function useClampedRange(defaultValue: number, min: number, max: number) {
  const [value, setValue] = useState(defaultValue);
  const [text, setText] = useState(String(defaultValue));

  function commit(raw: string) {
    const n = clampInt(Number(raw), min, max, value);
    setValue(n);
    setText(String(n));
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setText(raw);
    const n = Number(raw);
    if (raw !== "" && Number.isFinite(n) && n >= min && n <= max) {
      setValue(n);
    }
  }

  function onInputBlur() {
    commit(text);
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") commit(text);
  }

  function onSliderChange(next: number | readonly number[]) {
    const n = Array.isArray(next) ? next[0]! : (next as number);
    const clamped = clampInt(n, min, max, value);
    setValue(clamped);
    setText(String(clamped));
  }

  return { value, text, onInputChange, onInputBlur, onInputKeyDown, onSliderChange };
}

export default function ManualControls({ onCommand, disabled = false }: ManualControlsProps) {
  const distance = useClampedRange(DIST_DEFAULT, DIST_MIN, DIST_MAX);
  const degree = useClampedRange(DEG_DEFAULT, DEG_MIN, DEG_MAX);

  return (
    <div className="flex flex-col gap-3.5">
      {/* Emergency LAND — immediate, distinct from the normal 착륙 button below. */}
      <Button
        type="button"
        disabled={disabled}
        onClick={() => onCommand({ action: "land" })}
        className="flex h-16 w-full flex-col gap-0.5 whitespace-normal bg-destructive text-xl font-extrabold uppercase tracking-wider text-white hover:bg-destructive/90"
      >
        <span className="flex items-center gap-2">
          <TriangleAlert className="size-6" />
          비상 착륙
        </span>
        <small className="block text-[11px] font-semibold normal-case tracking-normal opacity-85">
          눌러서 즉시 착륙 · 하드웨어 버튼이 진짜 최후 수단
        </small>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
            직접 제어
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          {/* Flight basics */}
          <div className="grid grid-cols-3 gap-2.5">
            <Button
              type="button"
              size="lg"
              disabled={disabled}
              onClick={() => onCommand({ action: "takeoff" })}
              className="h-12 flex-col gap-0.5 bg-emerald-600 text-white hover:bg-emerald-600/90"
            >
              <PlaneTakeoff className="size-4" />
              이륙
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={disabled}
              onClick={() => onCommand({ action: "land" })}
              className="h-12 flex-col gap-0.5 bg-amber-600 text-white hover:bg-amber-600/90"
            >
              <PlaneLanding className="size-4" />
              착륙
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={disabled}
              onClick={() => onCommand({ action: "battery" })}
              className="h-12 flex-col gap-0.5 bg-sky-600 text-white hover:bg-sky-600/90"
            >
              <BatteryMedium className="size-4" />
              배터리
            </Button>
          </div>

          <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            이동
          </div>

          {/* Distance control */}
          <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <Label htmlFor="distNum" className="shrink-0">
              거리
            </Label>
            <Input
              id="distNum"
              type="number"
              inputMode="numeric"
              min={DIST_MIN}
              max={DIST_MAX}
              step={DIST_STEP}
              value={distance.text}
              onChange={distance.onInputChange}
              onBlur={distance.onInputBlur}
              onKeyDown={distance.onInputKeyDown}
              className="w-24"
            />
            <span>cm</span>
            <Slider
              value={distance.value}
              onValueChange={distance.onSliderChange}
              min={DIST_MIN}
              max={DIST_MAX}
              step={DIST_STEP}
              className="flex-1"
            />
          </div>

          {/* Move d-pad */}
          <div className="grid grid-cols-3 grid-rows-3 gap-2.5">
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "forward", distance: distance.value })}
              className="col-start-2 row-start-1 h-14 flex-col gap-0.5"
              variant="secondary"
            >
              <ArrowUp className="size-5" />
              전진
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "left", distance: distance.value })}
              className="col-start-1 row-start-2 h-14 flex-col gap-0.5"
              variant="secondary"
            >
              <ArrowLeft className="size-5" />
              왼쪽
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "right", distance: distance.value })}
              className="col-start-3 row-start-2 h-14 flex-col gap-0.5"
              variant="secondary"
            >
              <ArrowRight className="size-5" />
              오른쪽
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "back", distance: distance.value })}
              className="col-start-2 row-start-3 h-14 flex-col gap-0.5"
              variant="secondary"
            >
              <ArrowDown className="size-5" />
              후진
            </Button>
          </div>

          {/* Up / down */}
          <div className="grid grid-cols-2 gap-2.5">
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "up", distance: distance.value })}
              className="h-12"
              variant="secondary"
            >
              ⤒ 상승
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "down", distance: distance.value })}
              className="h-12"
              variant="secondary"
            >
              ⤓ 하강
            </Button>
          </div>

          <Separator className="my-1" />

          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">회전</div>

          {/* Degree control */}
          <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <Label htmlFor="degNum" className="shrink-0">
              각도
            </Label>
            <Input
              id="degNum"
              type="number"
              inputMode="numeric"
              min={DEG_MIN}
              max={DEG_MAX}
              step={DEG_STEP}
              value={degree.text}
              onChange={degree.onInputChange}
              onBlur={degree.onInputBlur}
              onKeyDown={degree.onInputKeyDown}
              className="w-24"
            />
            <span>°</span>
            <Slider
              value={degree.value}
              onValueChange={degree.onSliderChange}
              min={DEG_MIN}
              max={DEG_MAX}
              step={DEG_STEP}
              className="flex-1"
            />
          </div>

          {/* Rotate */}
          <div className="grid grid-cols-2 gap-2.5">
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "ccw", degree: degree.value })}
              className="h-14"
              variant="secondary"
            >
              <RotateCcw className="size-5" />
              반시계
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => onCommand({ action: "cw", degree: degree.value })}
              className="h-14"
              variant="secondary"
            >
              시계
              <RotateCw className="size-5" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
