import { useEffect, useRef, useState } from 'react'

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
  /** Write text into the terminal without submitting. */
  onInsert: (text: string) => void
  /** Write text and press Enter. */
  onSend: (text: string) => void
  onClose: () => void
}

export default function VoiceInput({ onInsert, onSend, onClose }: Props) {
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
      setTranscript(
        Array.from(event.results, (result) => result[0]?.transcript ?? '').join(''),
      )
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
    <div className="voice-overlay" onClick={onClose}>
      <div className="voice-card" onClick={(e) => e.stopPropagation()}>
        <div className={`voice-status ${listening ? 'voice-status--live' : ''}`}>
          {listening ? '● Listening…' : 'Stopped'}
        </div>
        <textarea
          className="voice-transcript"
          placeholder="Speak — the transcript appears here and can be edited"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
        />
        {error && <div className="drawer-error">{error}</div>}
        <div className="voice-actions">
          <button className="voice-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="voice-button"
            disabled={!transcript.trim()}
            onClick={() => {
              stop()
              onInsert(transcript.trim())
              onClose()
            }}
          >
            Insert
          </button>
          <button
            className="voice-button voice-button--primary"
            disabled={!transcript.trim()}
            onClick={() => {
              stop()
              onSend(transcript.trim())
              onClose()
            }}
          >
            Send ⏎
          </button>
        </div>
      </div>
    </div>
  )
}
