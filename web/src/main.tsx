import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { trackVisualViewport } from './viewport'
import './styles.css'

// Before the first paint: the shell is sized from what this publishes.
trackVisualViewport()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Offline shell + installability; dev stays SW-free so HMR is never cached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
