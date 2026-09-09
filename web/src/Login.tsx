import { useCallback, useRef, useState } from 'react'
import { checkAuth, pairCodeIn, pairWithCode, setToken } from './api'
import { Button, Field, IconCapture, OrbitMark } from './components/ui'
import QrScanner, { qrScanSupported, qrScanUnavailable } from './QrScanner'

interface Props {
  onSuccess: () => void
  notice?: string | null
}

const SERVER_UNREACHABLE = 'Cannot reach the Orbit server on your Mac'
const TOKEN_REJECTED = 'That token doesn’t match — check the server console'
const PAIR_CODE_EXPIRED =
  'That pairing code has expired — run `orbit pair` on the Mac for a fresh one'

export default function Login({ onSuccess, notice = null }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(notice)
  const [scanning, setScanning] = useState(false)
  const attemptInFlight = useRef(false)

  const beginAttempt = useCallback((): boolean => {
    if (attemptInFlight.current) return false
    attemptInFlight.current = true
    setBusy(true)
    setError(null)
    return true
  }, [])

  const endAttempt = useCallback(() => {
    attemptInFlight.current = false
    setBusy(false)
  }, [])

  const connect = useCallback(
    async (token: string) => {
      const trimmed = token.trim()
      if (!trimmed || !beginAttempt()) return
      setToken(trimmed)
      try {
        if (await checkAuth()) onSuccess()
        else setError(TOKEN_REJECTED)
      } catch {
        setError(SERVER_UNREACHABLE)
      } finally {
        endAttempt()
      }
    },
    [onSuccess, beginAttempt, endAttempt],
  )

  const pairWithScannedCode = useCallback(
    (code: string) => {
      if (!beginAttempt()) return
      void pairWithCode(code)
        .then((ok) => {
          if (ok) onSuccess()
          else setError(PAIR_CODE_EXPIRED)
        })
        .catch(() => setError(SERVER_UNREACHABLE))
        .finally(endAttempt)
    },
    [onSuccess, beginAttempt, endAttempt],
  )

  const onScanned = useCallback(
    (text: string) => {
      setScanning(false)
      const code = pairCodeIn(text)
      if (code) {
        pairWithScannedCode(code)
        return
      }
      setValue(text)
      void connect(text)
    },
    [connect, pairWithScannedCode],
  )

  return (
    <div className="app-fill flex items-center justify-center p-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-5">
        <OrbitMark size={64} halo />
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold tracking-wide">Orbit</h1>
          <p className="mt-2 text-sm leading-relaxed text-mut">
            Pair with your Mac: scan the QR code on its screen, or type the
            access token printed beside it
            (<code className="font-mono text-xs text-fore">[orbit] access token</code>)
          </p>
        </div>
        <Field
          type="password"
          placeholder="Access token"
          className="text-center"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && connect(value)}
        />
        {error && <div className="text-center text-sm text-danger">{error}</div>}
        <Button className="w-full py-3" disabled={busy || !value.trim()} onClick={() => connect(value)}>
          {busy ? 'Checking…' : 'Connect'}
        </Button>
        {qrScanSupported() ? (
          <Button variant="outline" className="w-full py-3" disabled={busy} onClick={() => setScanning(true)}>
            <IconCapture size={18} />
            Scan QR code
          </Button>
        ) : (
          <p className="text-center text-xs leading-relaxed text-faint">
            {qrScanUnavailable()} — until then, type the token.
          </p>
        )}
      </div>
      {scanning && <QrScanner onResult={onScanned} onClose={() => setScanning(false)} />}
    </div>
  )
}
