import { useCallback, useRef, useState } from 'react'
import { checkAuth, setToken } from './api'
import { Button, Field, IconCapture, OrbitMark } from './components/ui'
import QrScanner, { qrScanSupported, qrScanUnavailable } from './QrScanner'

interface Props {
  onSuccess: () => void
}

export default function Login({ onSuccess }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  // The scanner's onResult must not change between renders or its effect tears
  // the camera down and starts it again; the in-flight guard therefore lives in
  // a ref rather than in the memoised callback's dependencies.
  const busyRef = useRef(false)

  const connect = useCallback(
    async (token: string) => {
      const trimmed = token.trim()
      if (!trimmed || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setError(null)
      setToken(trimmed)
      try {
        if (await checkAuth()) onSuccess()
        else setError('That token doesn’t match — check the server console')
      } catch {
        setError('Cannot reach the Orbit server on your Mac')
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [onSuccess],
  )

  /* A successful decode connects on its own instead of filling the field and
     waiting for a tap. There is nothing for the user to confirm: the token is
     random base64 shown in a password field, so reading it back tells them
     nothing, and the QR came from the very server they are pairing with. A bad
     scan costs one error message and leaves the field editable, which is
     cheaper than a confirmation step every single pairing has to pass. */
  const onScanned = useCallback(
    (token: string) => {
      setScanning(false)
      setValue(token)
      void connect(token)
    },
    [connect],
  )

  return (
    <div className="app-fill flex items-center justify-center p-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-5">
        <OrbitMark size={64} halo />
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold tracking-wide">Orbit</h1>
          <p className="mt-2 text-sm leading-relaxed text-mut">
            Pair with your Mac: scan the QR code in the server console, or type the
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
          /* Saying why beats a button that cannot work: over plain http on the
             LAN the camera is refused outright, and that is not the user's fault
             to guess at. */
          <p className="text-center text-xs leading-relaxed text-faint">
            {qrScanUnavailable()} — until then, type the token.
          </p>
        )}
      </div>
      {scanning && <QrScanner onResult={onScanned} onClose={() => setScanning(false)} />}
    </div>
  )
}
