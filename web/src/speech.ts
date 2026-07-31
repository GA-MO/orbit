/* Web Speech API wrapper. iOS Safari is the strict case and drives the design:
   - recognition must be started synchronously inside the tap that asked for it,
     so a session is created by the mic button and the sheet only attaches to it;
   - `continuous` is not honoured — the recogniser ends after a pause, and
     restarting it outside a user gesture is refused with `service-not-allowed`,
     so restarts are an explicit button and the transcript accumulates across runs;
   - the whole API is refused on insecure origins, hence the isSecureContext gate. */

type Alternatives = ArrayLike<{ transcript: string }>

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { results: ArrayLike<Alternatives> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}

const getRecognizer = (): (new () => SpeechRecognitionLike) | null => {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Mac') && 'ontouchend' in document)

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true

export const speechSupported = () => getRecognizer() !== null && window.isSecureContext

/* Dictation recognises one language per run — it will not pick Thai out of a
   run set to English — so the language is an explicit, remembered choice. */
export const SPEECH_LANGS = [
  { code: 'th-TH', label: 'ไทย' },
  { code: 'en-US', label: 'EN' },
] as const

const LANG_KEY = 'orbit.speechLang'

export const getSpeechLang = (): string => {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved && SPEECH_LANGS.some((l) => l.code === saved)) return saved
  } catch {
    /* private mode — fall through to the device language */
  }
  return navigator.language?.startsWith('th') ? 'th-TH' : 'en-US'
}

/* iOS gates dictation behind three separate switches and reports all of them as
   the same `service-not-allowed`, so the message has to name all three. */
const IOS_PERMISSION_STEPS =
  'Check all three on the iPhone: Settings → Privacy & Security → Speech Recognition → Safari ON; Settings → General → Keyboard → Enable Dictation ON; and in Safari tap “AA” → Website Settings → Microphone → Allow. Reload the page after changing any of them.'

const errorMessage = (code: string): string => {
  switch (code) {
    case 'not-allowed':
      return `Microphone access denied. ${IOS_PERMISSION_STEPS}`
    case 'service-not-allowed':
      return isStandalone()
        ? 'iOS does not allow speech recognition in home-screen web apps. Open Orbit in Safari instead.'
        : `iOS refused the dictation service. ${IOS_PERMISSION_STEPS}`
    case 'audio-capture':
      return 'No microphone available'
    case 'network':
      return 'Dictation runs on Apple’s servers and needs internet access on the phone'
    case 'no-speech':
      return 'Did not catch anything — start again and speak'
    case 'language-not-supported':
      return `Dictation does not support ${navigator.language}`
    default:
      return `Speech error: ${code}`
  }
}

const joinRuns = (committed: string, run: string) =>
  committed && run ? `${committed.replace(/\s+$/, '')} ${run}` : committed || run

/* iOS does not reliably raise the microphone prompt for a SpeechRecognition
   start — it just refuses. getUserMedia does raise it, so the first attempt
   primes permission through that and only then starts the recogniser. */
const MIC_GRANTED_KEY = 'orbit.micGranted'
const micPrimed = () => {
  try {
    return localStorage.getItem(MIC_GRANTED_KEY) === '1'
  } catch {
    return false
  }
}

export class SpeechSession {
  transcript = ''
  listening = false
  preparing = false
  lang = getSpeechLang()
  error: string | null = null
  /** Raw Web Speech error code, shown in diagnostics — the message is a translation of it. */
  code: string | null = null

  /* Set by the sheet once it mounts; state reached before then is already on
     the fields above, so nothing is lost between the tap and the first render. */
  onChange: (() => void) | null = null

  private rec: SpeechRecognitionLike | null = null
  private committed = ''
  private disposed = false

  /** Must be called synchronously from a user gesture on iOS. */
  start() {
    if (this.disposed || this.listening || this.preparing) return
    const Recognizer = getRecognizer()
    if (!Recognizer) {
      this.error = window.isSecureContext
        ? 'Speech recognition is not supported in this browser'
        : 'Speech recognition needs a secure connection (https). See docs/TAILSCALE.md.'
      this.emit()
      return
    }
    if (micPrimed() || !navigator.mediaDevices) this.launch(Recognizer)
    else this.prime(Recognizer)
  }

  /* getUserMedia is called inside the same gesture; the recogniser then starts
     from its callback, which iOS accepts because the grant just happened. */
  private prime(Recognizer: new () => SpeechRecognitionLike) {
    this.preparing = true
    this.error = null
    this.emit()
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop())
        try {
          localStorage.setItem(MIC_GRANTED_KEY, '1')
        } catch {
          /* private mode — priming just repeats next time */
        }
        this.preparing = false
        if (!this.disposed) this.launch(Recognizer)
      })
      .catch((err: { name?: string }) => {
        this.preparing = false
        this.code = err?.name ?? 'getUserMedia-failed'
        this.error = errorMessage('not-allowed')
        this.emit()
      })
  }

  private launch(Recognizer: new () => SpeechRecognitionLike) {
    const rec = new Recognizer()
    this.rec = rec
    rec.continuous = !isIOS()
    rec.interimResults = true
    rec.lang = this.lang
    rec.onresult = (event) => {
      const run = Array.from(event.results, (r) => r[0]?.transcript ?? '').join('')
      this.transcript = joinRuns(this.committed, run)
      this.error = null
      this.code = null
      this.emit()
    }
    rec.onend = () => {
      if (rec !== this.rec) return
      this.committed = this.transcript
      this.listening = false
      this.emit()
    }
    rec.onerror = (event) => {
      if (rec !== this.rec || event.error === 'aborted') return
      // A refused start still leaves listening true until onend, which iOS does
      // not always fire — clear it here so the sheet never shows "Listening…" over an error.
      this.listening = false
      this.code = event.error
      this.error = errorMessage(event.error)
      this.emit()
    }

    try {
      rec.start()
      this.listening = true
      this.error = null
      this.code = null
    } catch (err) {
      // Refused outright — surface it rather than hanging on "Listening…".
      this.listening = false
      this.code = (err as { name?: string })?.name ?? 'start-threw'
      this.error = errorMessage('service-not-allowed')
    }
    this.emit()
  }

  stop() {
    this.rec?.stop()
  }

  /** Switching language mid-session restarts the recogniser — safe because the
      only caller is a tap on the language chip, which is the gesture iOS wants. */
  setLang(code: string) {
    if (code === this.lang) return
    this.lang = code
    try {
      localStorage.setItem(LANG_KEY, code)
    } catch {
      /* private mode — the choice just does not persist */
    }
    // While preparing, the pending getUserMedia callback launches and picks up
    // the new language on its own — only a running recogniser needs replacing.
    if (this.listening) {
      this.committed = this.transcript
      const rec = this.rec
      this.rec = null
      rec?.abort()
      this.listening = false
      this.start()
    }
    this.emit()
  }

  /** Textarea edits become the new baseline so a restart appends to them. */
  setTranscript(text: string) {
    this.transcript = text
    this.committed = text
    this.emit()
  }

  dispose() {
    this.disposed = true
    this.preparing = false
    this.onChange = null
    const rec = this.rec
    this.rec = null
    rec?.abort()
  }

  /* Phones have no devtools — when a start is refused this is the only way to
     tell which precondition actually failed. */
  diagnostics() {
    return [
      window.isSecureContext ? 'https ✓' : 'https ✗',
      isStandalone() ? 'home-screen app' : 'browser tab',
      micPrimed() ? 'mic ✓' : 'mic not granted',
      this.lang,
      this.code ? `code: ${this.code}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  private emit() {
    this.onChange?.()
  }
}

/** Create and start a session. Call this directly in the tap handler. */
export const startSpeech = (): SpeechSession => {
  const session = new SpeechSession()
  session.start()
  return session
}
