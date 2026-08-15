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
// Floor between PASSIVE checks only. Visibility flips are frequent on mobile
// PWAs and each one otherwise costs a service-worker script fetch plus a
// no-store manifest fetch; single-flight merges concurrent calls but not
// consecutive ones. The user-initiated CTA always bypasses this.
const PASSIVE_CHECK_FLOOR_MS = 30_000
const reportedCompatibilityErrors = new Set<string>()

function reportCompatibilityError(error: unknown, source: string) {
  const key = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  if (reportedCompatibilityErrors.has(key)) return
  reportedCompatibilityErrors.add(key)
  captureError(error, { source })
}

interface CheckFloor {
  /** The passive check currently in flight (null when idle). Kept as the
   *  promise, not a boolean: a forced check that collides with it must WAIT
   *  for it and then fetch fresh — see the force branch in runFloored. */
  pending:       Promise<unknown> | null
  lastSuccessAt: number
  /** A passive signal (online / visibility) arrived while a check was still
   *  in flight. Without remembering it, that wakeup is LOST: the in-flight
   *  check may have started before the network came back, so its failure
   *  proves nothing, yet nothing would retry until the periodic timer. */
  retryRequested: boolean
}

/** Runs `check` unless a recent SUCCESS or an in-flight passive attempt says
 *  otherwise. The floor advances on success only: a failed check accomplished
 *  nothing, and burning the quota on it would make the `online` event — the
 *  one signal that says "the network is back, try again" — a no-op for the
 *  next 30s. A signal skipped because of an in-flight check schedules one
 *  trailing retry, which runs only if that check fails (success already
 *  produced data fresher than the signal). `force` is the user's CTA and
 *  ignores every condition.
 *
 *  Timestamps use performance.now(), not Date.now(): the wall clock can jump
 *  backwards (NTP sync, manual re-set), which would make the elapsed time
 *  negative and freeze every passive check until the clock catches back up —
 *  exactly the window where a stale bundle needs the new minimumWriteEpoch. */
function runFloored(
  floor: CheckFloor,
  force: boolean,
  check: () => Promise<unknown>,
): Promise<void> {
  if (force) {
    // A passive attempt already in the air was issued BEFORE the user's tap,
    // and the service-level single-flight would hand that same request back —
    // if it fails (or carries a pre-rollback manifest) the CTA would be a
    // silent no-op. Settle it first, then fetch fresh: the forced request
    // must START after the tap.
    const prior = floor.pending ?? Promise.resolve()
    return prior
      .then(() => undefined, () => undefined)
      .then(() => check())
      .then(
        () => {
          floor.lastSuccessAt = performance.now()
          floor.retryRequested = false
        },
        () => undefined,
      )
  }
  if (floor.pending) {
    floor.retryRequested = true
    return Promise.resolve()
  }
  if (performance.now() - floor.lastSuccessAt < PASSIVE_CHECK_FLOOR_MS) return Promise.resolve()
  const run = check()
    .then(
      () => {
        floor.lastSuccessAt = performance.now()
        floor.retryRequested = false
      },
      () => undefined,
    )
    .finally(() => {
      floor.pending = null
      if (floor.retryRequested) {
        floor.retryRequested = false
        void runFloored(floor, false, check)
      }
    })
  floor.pending = run
  return run
}

function reportingRethrow(source: string) {
  return (error: unknown): never => {
    reportCompatibilityError(error, source)
    throw error
  }
}

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const [checkingForUpdate, setCheckingForUpdate] = useState(false)
  // Tracked separately on purpose: a shared floor would let the boot manifest
  // check swallow the first onRegistered worker check, which is the one that
  // catches a deploy that landed while the app was closed.
  // -Infinity, not 0: performance.now() starts near 0 at page load, so a 0
  // sentinel would look like "checked just now" and throttle the boot check.
  const workerFloor   = useRef<CheckFloor>({ pending: null, lastSuccessAt: Number.NEGATIVE_INFINITY, retryRequested: false })
  const manifestFloor = useRef<CheckFloor>({ pending: null, lastSuccessAt: Number.NEGATIVE_INFINITY, retryRequested: false })

  function checkWorker(registration: ServiceWorkerRegistration, force = false) {
    return runFloored(workerFloor.current, force, () =>
      registration.update().catch(reportingRethrow('pwa-sw-update-check')))
  }

  function checkManifest(force = false) {
    return runFloored(manifestFloor.current, force, () =>
      refreshClientCompatibility().catch(reportingRethrow('pwa-compatibility-refresh')))
  }

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration) {
      registrationRef.current = registration
      if (registration) void checkWorker(registration)
      void checkManifest()
    },
    onRegisterError(error) {
      captureError(error, { source: 'pwa-sw-register' })
    },
  })

  useEffect(() => {
    function runChecks() {
      if (document.visibilityState !== 'visible') return
      if (registrationRef.current) void checkWorker(registrationRef.current)
      void checkManifest()
    }

    // Compatibility is useful even when SW registration is unsupported or
    // delayed, so its boot check is independent of onRegistered.
    void checkManifest()

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
    // A waiting worker means the new bundle is already on disk; activating it
    // reloads, which re-reads the manifest on boot.
    if (needRefresh) {
      activateUpdate()
      return
    }

    // Nothing to interrogate — a full reload is the only recovery, and it also
    // re-fetches the manifest during boot.
    const registration = registrationRef.current
    if (!registration) {
      window.location.reload()
      return
    }

    setCheckingForUpdate(true)
    // The manual CTA bypasses the passive floor and refreshes BOTH surfaces.
    // An emergency rollback lowers minimumWriteEpoch without shipping a new
    // worker, so a worker-only check would leave a blocked user stuck until
    // the next periodic sweep.
    const manifestCheck = checkManifest(true)
    const workerCheck = checkWorker(registration, true)
      .then(() => {
        if (registration.waiting) activateUpdate()
      })
    void Promise.all([manifestCheck, workerCheck])
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
