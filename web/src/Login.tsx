import { useState } from 'react'
import { checkAuth, setToken } from './api'

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
      if (await checkAuth()) {
        onSuccess()
      } else {
        setError('Invalid token')
      }
    } catch {
      setError('Cannot reach the Orbit server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-logo">⌁ Orbit</div>
        <p className="login-hint">
          Enter the access token printed in the server console on your Mac
          (<code>[orbit] access token: …</code>)
        </p>
        <input
          className="login-input"
          type="password"
          placeholder="Access token"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="login-error">{error}</div>}
        <button className="start-button" disabled={busy || !value.trim()} onClick={submit}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
