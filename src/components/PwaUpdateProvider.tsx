import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { captureError } from '@/services/sentry'
import {
  CLIENT_COMPATIBILITY_STORAGE_KEY,
  refreshClientCompatibility,
  syncClientCompatibilityFromStorage,
} from '@/services/clientCompatibility'
import { PwaUpdateContext } from '@/hooks/usePwaUpdate'

const PERIODIC_CHECK_MS = 3 * 60_000
const reportedCompatibilityErrors = new Set<string>()

function reportCompatibilityError(error: unknown, source: string) {
  const key = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  if (reportedCompatibilityErrors.has(key)) return
  reportedCompatibilityErrors.add(key)
  captureError(error, { source })
}

function refreshCompatibilityInBackground() {
  void refreshClientCompatibility().catch(error => {
    reportCompatibilityError(error, 'pwa-compatibility-refresh')
  })
}

function updateRegistrationInBackground(
  registration: ServiceWorkerRegistration,
  source: string,
) {
  void registration.update().catch(error => {
    reportCompatibilityError(error, source)
  })
}

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const [checkingForUpdate, setCheckingForUpdate] = useState(false)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration) {
      registrationRef.current = registration
      if (registration) updateRegistrationInBackground(registration, 'pwa-sw-update-check')
      refreshCompatibilityInBackground()
    },
    onRegisterError(error) {
      captureError(error, { source: 'pwa-sw-register' })
    },
  })

  useEffect(() => {
    function runChecks() {
      if (document.visibilityState !== 'visible') return
      if (registrationRef.current) {
        updateRegistrationInBackground(registrationRef.current, 'pwa-sw-update-check')
      }
      refreshCompatibilityInBackground()
    }

    // Compatibility is useful even when SW registration is unsupported or
    // delayed, so its boot check is independent of onRegistered.
    refreshCompatibilityInBackground()

    const intervalId = window.setInterval(runChecks, PERIODIC_CHECK_MS)
    const onVisibility = () => runChecks()
    const onOnline = () => runChecks()
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) runChecks()
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CLIENT_COMPATIBILITY_STORAGE_KEY) return
      try {
        syncClientCompatibilityFromStorage(event.newValue)
      } catch (error) {
        reportCompatibilityError(error, 'pwa-compatibility-storage')
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('storage', onStorage)
    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  function dismissUpdate() {
    setNeedRefresh(false)
  }

  function activateUpdate() {
    void updateServiceWorker(true).catch(error => {
      captureError(error, { source: 'pwa-sw-activate' })
    })
  }

  function requestUpdate() {
    if (needRefresh) {
      activateUpdate()
      return
    }

    const registration = registrationRef.current
    if (!registration) {
      window.location.reload()
      return
    }

    setCheckingForUpdate(true)
    void registration.update()
      .then(() => {
        if (registration.waiting) activateUpdate()
      })
      .catch(error => captureError(error, { source: 'pwa-sw-update-check' }))
      .finally(() => setCheckingForUpdate(false))
  }

  return (
    <PwaUpdateContext.Provider value={{
      needRefresh,
      checkingForUpdate,
      dismissUpdate,
      activateUpdate,
      requestUpdate,
    }}>
      {children}
    </PwaUpdateContext.Provider>
  )
}
