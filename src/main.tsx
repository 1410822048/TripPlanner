// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initSentry } from './services/sentry'
import './index.css'
import App from './App.tsx'

// Boot Sentry before React mounts so an early render-time crash gets
// captured (init after mount → first error in App init slips through
// uncaught). No-op when VITE_SENTRY_DSN isn't set.
initSentry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
