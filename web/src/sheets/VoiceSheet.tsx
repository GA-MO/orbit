import { useEffect, useReducer } from 'react'
import { Button, IconButton, IconImage, IconMic, Sheet } from '../components/ui'
import { SPEECH_LANGS, type SpeechSession } from '../speech'

interface Props {
  session: SpeechSession
  /** Opens the picker; the uploaded path is appended to the transcript. */
  onImage: () => void
  onInsert: (text: string) => void
  onSend: (text: string) => void
  onClose: () => void
}

export default function VoiceSheet({ session, onImage, onInsert, onSend, onClose }: Props) {
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
        {/* The button this sheet is actually driven by, and it used to be a 13px
            text link wedged between the status and the language pills. iOS does
            not honour `continuous`: the recogniser ends after every pause, so
            picking the thread back up is the most-pressed control here — far
            more than Send — and it needs the full width and the 44px floor that
            every other control in the app has. It is one button in both
            directions, because stopping deliberately (rather than by trailing
            off) had nowhere to go before. */}
        <Button
          variant="outline"
          className={`w-full ${live ? '' : 'text-accent'}`}
          disabled={preparing}
          onClick={() => (live ? session.stop() : session.start())}
        >
          {live ? (
            <>
              <span className="pulse-live size-2 rounded-full bg-danger" />
              Stop listening
            </>
          ) : (
            <>
              <IconMic size={17} />
              {ready ? 'Continue listening' : 'Start listening'}
            </>
          )}
        </Button>
        {error && (
          <div className="flex flex-col gap-1">
            <div className="text-sm text-danger">{error}</div>
            <div className="text-[11px] text-faint">{session.diagnostics()}</div>
          </div>
        )}
        <div className="flex items-center gap-2">
          {/* Same button, same corner of the same panel as the message sheet.
              Dictating a sentence about a screenshot is one thought, and having
              to back out to the pen to attach the screenshot breaks it — the
              path lands in the transcript, which is the text this sheet is
              showing. */}
          <IconButton label="Upload an image and add its path" size="lg" onClick={onImage}>
            <IconImage size={19} />
          </IconButton>
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
