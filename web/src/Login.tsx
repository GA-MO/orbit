import { useState } from 'react'
import { checkAuth, setToken } from './api'
import { Button, Field, OrbitMark } from './components/ui'

interface Props {
  onSuccess: () => void
}

export default function Login({ onSuccess }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    setToken(value.trim())
    try {
      if (await checkAuth()) onSuccess()
      else setError('That token doesn’t match — check the server console')
    } catch {
      setError('Cannot reach the Orbit server on your Mac')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-5">
        <OrbitMark size={64} />
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold tracking-wide">Orbit</h1>
          <p className="mt-2 text-sm leading-relaxed text-mut">
            Pair with your Mac: enter the access token from the server console
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
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="text-center text-sm text-danger">{error}</div>}
        <Button className="w-full py-3" disabled={busy || !value.trim()} onClick={submit}>
          {busy ? 'Checking…' : 'Connect'}
        </Button>
      </div>
    </div>
  )
}
