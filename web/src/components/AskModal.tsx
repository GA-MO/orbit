import type { AskRequest } from "../Terminal";
import { Button, shortPath } from "./ui";

interface Props {
  request: AskRequest;
  onAnswer: (choice: string) => void;
}

const DEFAULT_OPTIONS = ["Allow", "Deny"];

const optionsLayout = (count: number) =>
  count === 2 ? "flex-row-reverse" : "flex-col";

export default function AskModal({ request, onAnswer }: Props) {
  const options = request.options.length ? request.options : DEFAULT_OPTIONS;

  return (
    <div className="fade-in app-fill z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-[2px]">
      <div className="pop-in lift flex w-full max-w-md flex-col gap-3.5 rounded-2xl border border-accent/40 bg-surface p-5">
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

        <div className={`flex gap-2 ${optionsLayout(options.length)}`}>
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
