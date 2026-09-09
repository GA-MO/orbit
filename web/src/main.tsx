import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { trackVisualViewport } from './viewport'
import './styles.css'

const installOfflineShell = () => {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

trackVisualViewport()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

installOfflineShell()
