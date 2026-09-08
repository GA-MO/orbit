import { useState } from "react";
import { PRESETS, type PresetId } from "../api";
import { Sheet, TogglePill, useArrival } from "../components/ui";

interface Props {
  /** What the shot will be of, in the words the gallery will file it under. */
  subject: string;
  onChoose: (preset: PresetId, fullPage: boolean) => void;
  onClose: () => void;
}

/**
 * The viewport question, asked at the moment it is answerable.
 *
 * It used to be a settings row parked under the list: three segments and a
 * checkbox that changed nothing you could see, governing a ⧉ several rows away
 * that never mentioned them. You set it once, forgot it, and every capture for
 * the rest of the week came back at whatever the last shot happened to need.
 * Asking here costs one extra tap and buys back both the strip of fold the row
 * occupied and the certainty of what you are about to get.
 *
 * The three sizes are buttons rather than a selection, because the choice *is*
 * the trigger — picking Tablet and then hunting for a confirm would be the same
 * two-step split this sheet exists to close. Full page sits above them as a
 * modifier, since it changes what each of the three does rather than replacing
 * them: the server renders every shot at a preset's viewport width and only
 * lets the height run past the fold, so "full page" on its own is not a size it
 * could honour. A fourth segment would have had to invent one.
 *
 * That distinction — trigger versus modifier — is real and worth drawing, but
 * it used to be drawn with a checkbox, which was the wrong way to draw it. A
 * checkbox was the only checkbox left in an app made of pills and glass, and it
 * looked like what it was: a fragment of the settings row this sheet replaced.
 * It is a TogglePill now, the same material as everything around it, on when it
 * is brighter. What tells you it worked is not the pill: it is the three
 * captions below flipping from `390 × 844` to `390 wide`, which is the sheet
 * saying what the flag actually changed rather than repeating that you set it.
 *
 * Nothing here is remembered. A sticky default is exactly the invisible state
 * the settings row was, only hidden better, and the sheet opens too rarely for
 * re-picking to cost anything.
 */
export default function CaptureSheet({ subject, onChoose, onClose }: Props) {
  const [fullPage, setFullPage] = useState(false);
  const arrive = useArrival(["full", ...PRESETS.map((p) => `preset:${p.id}`)]);

  return (
    <Sheet title="Capture" onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 pt-1 pb-4">
        {/* The subject, verbatim and monospaced. This sheet is opened from a row
            in a list of near-identical rows, and one opened from the wrong port
            is otherwise indistinguishable from the right one until the shot
            lands in the gallery under a name you did not expect. */}
        <p className="truncate font-mono text-xs text-mut">{subject}</p>

        {/* `w-fit`, so the modifier does not span the sheet the way the three
            triggers below it do — it is a smaller decision and takes less of
            the width. `min-h-11` inside TogglePill keeps the thumb honest. */}
        <TogglePill
          pressed={fullPage}
          onChange={setFullPage}
          className={`${arrive("full").className} w-fit`}
          style={arrive("full").style}
        >
          Full page
        </TogglePill>

        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChoose(p.id, fullPage)}
              /* `pill` is the material, not the shape: the face, the top
                 hairline and the 140deg rim come with it, and the radius stays
                 the field's, so these read as the same stuff as every button in
                 the app cut to a different outline. h-16 clears the 44px
                 floor with room for the caption. */
              className={`${arrive(`preset:${p.id}`).className} press pill flex h-16 flex-col items-center justify-center gap-0.5 rounded-(--radius-field) text-sm font-medium text-fore`}
              style={arrive(`preset:${p.id}`).style}
            >
              {p.label}
              {/* Only the width is promised when the page runs long, because
                  only the width is kept: the preset's height sets the viewport
                  and a full-page shot then grows past it. Printing 390 × 844
                  under a checked Full page would be a number the file never
                  matches. */}
              <span className="font-mono text-[10px] text-faint">
                {fullPage ? `${p.width} wide` : `${p.width} × ${p.height}`}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
