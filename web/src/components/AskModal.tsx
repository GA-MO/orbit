import type { AskRequest } from "../Terminal";
import { Button, shortPath } from "./ui";

interface Props {
  request: AskRequest;
  onAnswer: (choice: string) => void;
}

/**
 * A question raised on the Mac — by an agent through the MCP server, or by the
 * approval hook holding a command. Something over there is blocked until this
 * is tapped, so there is no dismiss: every path answers.
 */
export default function AskModal({ request, onAnswer }: Props) {
  const options = request.options.length ? request.options : ["Allow", "Deny"];
  /* The first option is the emphasised one and sits where a thumb lands — so
     whoever asks puts the safe choice first. Two options read as a decision;
     more than two stack. */
  const layout = options.length === 2 ? "flex-row-reverse" : "flex-col";

  return (
    <div className="fade-in app-fill z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-[2px]">
      <div className="pop-in lift flex w-full max-w-md flex-col gap-3.5 rounded-2xl border border-accent/40 bg-surface p-5">
        {/* The header is a title and a provenance line, and a long project
            path used to break it: the title wrapped to two lines and the
            truncated path sat beside the second one, so the modal opened
            looking broken.

            The title never wraps now — it is four words and it is the thing
            you read first — and the path takes whatever is left, truncating
            from the head so the end of a path (which is the part that
            identifies it) survives. `min-w-0` is what lets it shrink at all
            inside a flex row; without it a long path refuses to truncate and
            pushes the title instead, which is how this started. */}
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-display shrink-0 text-[15px] font-semibold whitespace-nowrap text-accent">
            Your Mac is asking
          </span>
          {request.source && (
            <span
              dir="rtl"
              className="min-w-0 truncate text-right font-mono text-[11px] text-faint"
              title={shortPath(request.source)}
            >
              <bdi>{shortPath(request.source)}</bdi>
            </span>
          )}
        </div>

        <div className="text-[15px] text-fore">{request.question}</div>

        {request.detail && (
          <code className="max-h-40 overflow-y-auto rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 font-mono text-[13px] break-all whitespace-pre-wrap">
            {request.detail}
          </code>
        )}

        <div className={`flex gap-2 ${layout}`}>
          {options.map((option, i) => (
            <Button
              key={option}
              variant={i === 0 ? "primary" : "outline"}
              className="flex-1"
              onClick={() => onAnswer(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
