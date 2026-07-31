import { useEffect, useRef, useState } from 'react'
import { Button, Sheet } from '../components/ui'

/* Minimal typings — the Web Speech API is not in lib.dom for all targets. */
type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  stop(): void
}

const getRecognizer = (): (new () => SpeechRecognitionLike) | null => {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

export const speechSupported = () => getRecognizer() !== null

interface Props {
  onInsert: (text: string) => void
  onSend: (text: string) => void
  onClose: () => void
}

export default function VoiceSheet({ onInsert, onSend, onClose }: Props) {
  const [transcript, setTranscript] = useState('')
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)

  useEffect(() => {
    const Recognizer = getRecognizer()
    if (!Recognizer) {
      setError('Speech recognition is not supported in this browser')
      return
    }
    const rec = new Recognizer()
    recRef.current = rec
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'
    rec.onresult = (event) => {
      setTranscript(Array.from(event.results, (r) => r[0]?.transcript ?? '').join(''))
    }
    rec.onend = () => setListening(false)
    rec.onerror = (event) => {
      if (event.error === 'not-allowed') setError('Microphone access denied')
      else if (event.error !== 'aborted') setError(`Speech error: ${event.error}`)
    }
    rec.start()
    setListening(true)
    return () => rec.stop()
  }, [])

  const stop = () => recRef.current?.stop()

  return (
    <Sheet title="Voice input" onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 pt-1 pb-4">
        <div className="flex items-center gap-2 text-[13px]">
          <span
            className={`size-2 rounded-full ${listening ? 'pulse-live bg-danger' : 'bg-faint'}`}
          />
          <span className={listening ? 'text-fore' : 'text-mut'}>
            {listening ? 'Listening…' : 'Stopped'}
          </span>
        </div>
        <textarea
          className="min-h-24 resize-none rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 text-[15px] text-fore outline-none placeholder:text-faint focus:border-accent"
          placeholder="Speak — the transcript appears here and can be edited"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
        />
        {error && <div className="text-sm text-danger">{error}</div>}
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            disabled={!transcript.trim()}
            onClick={() => {
              stop()
              onInsert(transcript.trim())
              onClose()
            }}
          >
            Insert
          </Button>
          <Button
            className="flex-1"
            disabled={!transcript.trim()}
            onClick={() => {
              stop()
              onSend(transcript.trim())
              onClose()
            }}
          >
            Send ⏎
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
