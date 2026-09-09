import { useState } from "react";
import { PRESETS, type PresetId } from "../api";
import { Sheet, TogglePill, useArrival } from "../components/ui";

interface Props {
  subject: string;
  onChoose: (preset: PresetId, fullPage: boolean) => void;
  onClose: () => void;
}

const FULL_PAGE_KEY = "full";
const presetKey = (id: PresetId) => `preset:${id}`;

function presetCaption(preset: (typeof PRESETS)[number], fullPage: boolean) {
  return fullPage ? `${preset.width} wide` : `${preset.width} × ${preset.height}`;
}

export default function CaptureSheet({ subject, onChoose, onClose }: Props) {
  const [fullPage, setFullPage] = useState(false);
  const arrive = useArrival([FULL_PAGE_KEY, ...PRESETS.map((preset) => presetKey(preset.id))]);

  return (
    <Sheet title="Capture" onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 pt-1 pb-4">
        <p className="truncate font-mono text-xs text-mut">{subject}</p>

        <TogglePill
          pressed={fullPage}
          onChange={setFullPage}
          className={`${arrive(FULL_PAGE_KEY).className} w-fit`}
          style={arrive(FULL_PAGE_KEY).style}
        >
          Full page
        </TogglePill>

        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChoose(preset.id, fullPage)}
              className={`${arrive(presetKey(preset.id)).className} press pill flex h-16 flex-col items-center justify-center gap-0.5 rounded-(--radius-field) text-sm font-medium text-fore`}
              style={arrive(presetKey(preset.id)).style}
            >
              {preset.label}
              <span className="font-mono text-[10px] text-faint">
                {presetCaption(preset, fullPage)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
