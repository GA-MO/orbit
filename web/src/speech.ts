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

type RecognizerClass = new () => SpeechRecognitionLike

const getRecognizer = (): RecognizerClass | null => {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as RecognizerClass | null
}

const IOS_USER_AGENT = /iP(hone|ad|od)/

const isIOS = () =>
  IOS_USER_AGENT.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Mac') && 'ontouchend' in document)

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true

export const speechSupported = () => getRecognizer() !== null && window.isSecureContext

export const SPEECH_LANGS = [
  { code: 'th-TH', label: 'ไทย' },
  { code: 'en-US', label: 'EN' },
] as const

const LANG_KEY = 'orbit.speechLang'

const deviceLang = (): string => (navigator.language?.startsWith('th') ? 'th-TH' : 'en-US')

export const getSpeechLang = (): string => {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved && SPEECH_LANGS.some((l) => l.code === saved)) return saved
  } catch {
    return deviceLang()
  }
  return deviceLang()
}

const rememberLang = (code: string) => {
  try {
    localStorage.setItem(LANG_KEY, code)
  } catch {
    return
  }
}

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

const TRAILING_WHITESPACE = /\s+$/

const joinRuns = (committed: string, run: string) =>
  committed && run ? `${committed.replace(TRAILING_WHITESPACE, '')} ${run}` : committed || run

const MIC_GRANTED_KEY = 'orbit.micGranted'

const micPrimed = () => {
  try {
    return localStorage.getItem(MIC_GRANTED_KEY) === '1'
  } catch {
    return false
  }
}

const rememberMicPrimed = () => {
  try {
    localStorage.setItem(MIC_GRANTED_KEY, '1')
  } catch {
    return
  }
}

const unsupportedMessage = () =>
  window.isSecureContext
    ? 'Speech recognition is not supported in this browser'
    : 'Speech recognition needs a secure connection (https). See docs/TAILSCALE.md.'

export class SpeechSession {
  transcript = ''
  listening = false
  preparing = false
  lang = getSpeechLang()
  error: string | null = null
  code: string | null = null

  onChange: (() => void) | null = null

  private rec: SpeechRecognitionLike | null = null
  private committed = ''
  private disposed = false

  start() {
    if (this.disposed || this.listening || this.preparing) return
    const Recognizer = getRecognizer()
    if (!Recognizer) {
      this.error = unsupportedMessage()
      this.emit()
      return
    }
    const needsMicPrimingOnIOS = !micPrimed() && Boolean(navigator.mediaDevices)
    if (needsMicPrimingOnIOS) this.primeMicThenLaunch(Recognizer)
    else this.launch(Recognizer)
  }

  private primeMicThenLaunch(Recognizer: RecognizerClass) {
    this.preparing = true
    this.error = null
    this.emit()
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop())
        rememberMicPrimed()
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

  private launch(Recognizer: RecognizerClass) {
    const rec = new Recognizer()
    this.rec = rec
    rec.continuous = !isIOS()
    rec.interimResults = true
    rec.lang = this.lang
    rec.onresult = (event) => this.onResult(event.results)
    rec.onend = () => {
      if (rec !== this.rec) return
      this.onRunEnded()
    }
    rec.onerror = (event) => {
      if (rec !== this.rec || event.error === 'aborted') return
      this.onRecognizerError(event.error)
    }

    try {
      rec.start()
      this.listening = true
      this.error = null
      this.code = null
    } catch (err) {
      this.listening = false
      this.code = (err as { name?: string })?.name ?? 'start-threw'
      this.error = errorMessage('service-not-allowed')
    }
    this.emit()
  }

  private onResult(results: ArrayLike<Alternatives>) {
    const run = Array.from(results, (alternatives) => alternatives[0]?.transcript ?? '').join('')
    this.transcript = joinRuns(this.committed, run)
    this.error = null
    this.code = null
    this.emit()
  }

  private onRunEnded() {
    this.committed = this.transcript
    this.listening = false
    this.emit()
  }

  private onRecognizerError(code: string) {
    this.listening = false
    this.code = code
    this.error = errorMessage(code)
    this.emit()
  }

  stop() {
    this.rec?.stop()
  }

  setLang(code: string) {
    if (code === this.lang) return
    this.lang = code
    rememberLang(code)
    if (this.listening) this.restartWithNewLang()
    this.emit()
  }

  private restartWithNewLang() {
    this.committed = this.transcript
    this.abortRecognizer()
    this.listening = false
    this.start()
  }

  private abortRecognizer() {
    const rec = this.rec
    this.rec = null
    rec?.abort()
  }

  setTranscript(text: string) {
    this.transcript = text
    this.committed = text
    this.emit()
  }

  dispose() {
    this.disposed = true
    this.preparing = false
    this.onChange = null
    this.abortRecognizer()
  }

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

export const startSpeech = (): SpeechSession => {
  const session = new SpeechSession()
  session.start()
  return session
}
