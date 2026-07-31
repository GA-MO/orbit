import { useEffect, useReducer } from 'react'
import { Button, Sheet } from '../components/ui'
import { SPEECH_LANGS, type SpeechSession } from '../speech'

interface Props {
  session: SpeechSession
  onInsert: (text: string) => void
  onSend: (text: string) => void
  onClose: () => void
}

export default function VoiceSheet({ session, onInsert, onSend, onClose }: Props) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  /* The session was started by the mic tap — iOS refuses a start that is not
     synchronous with a gesture — so the sheet only subscribes to it. */
  useEffect(() => {
    session.onChange = rerender
    rerender()
    return () => {
      session.onChange = null
    }
  }, [session])

  const { transcript, listening, preparing, error } = session
  const ready = transcript.trim().length > 0
  const state = preparing ? 'Waiting for microphone…' : listening ? 'Listening…' : 'Stopped'
  const live = listening || preparing

  const finish = (submit: (text: string) => void) => {
    session.stop()
    submit(transcript.trim())
    onClose()
  }

  return (
    <Sheet title="Voice input" onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 pt-1 pb-4">
        <div className="flex items-center gap-2 text-[13px]">
          <span className={`size-2 rounded-full ${live ? 'pulse-live bg-danger' : 'bg-faint'}`} />
          <span className={live ? 'text-fore' : 'text-mut'}>{state}</span>
          {!live && (
            <button className="text-[13px] font-medium text-accent" onClick={() => session.start()}>
              · {ready ? 'Continue' : 'Start'} listening
            </button>
          )}
          <div className="ml-auto flex gap-1 rounded-full bg-ink p-0.5">
            {SPEECH_LANGS.map(({ code, label }) => (
              <button
                key={code}
                aria-pressed={session.lang === code}
                className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors ${
                  session.lang === code ? 'bg-line text-fore' : 'text-mut'
                }`}
                onClick={() => session.setLang(code)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className="min-h-24 resize-none rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 text-[15px] text-fore outline-none placeholder:text-faint focus:border-accent"
          placeholder="Speak — the transcript appears here and can be edited"
          value={transcript}
          onChange={(e) => session.setTranscript(e.target.value)}
        />
        {error && (
          <div className="flex flex-col gap-1">
            <div className="text-sm text-danger">{error}</div>
            <div className="text-[11px] text-faint">{session.diagnostics()}</div>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            disabled={!ready}
            onClick={() => finish(onInsert)}
          >
            Insert
          </Button>
          <Button className="flex-1" disabled={!ready} onClick={() => finish(onSend)}>
            Send ⏎
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
