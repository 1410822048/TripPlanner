/// <reference lib="webworker" />

import { initializeApp } from 'firebase/app'
import {
  getMessaging,
  onBackgroundMessage,
  type MessagePayload,
} from 'firebase/messaging/sw'
import { ExpirationPlugin } from 'workbox-expiration'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { readPushOwnerUid } from './features/account/services/pushOwnerStore'

const sw = self as unknown as ServiceWorkerGlobalScope
type PrecacheManifest = Parameters<typeof precacheAndRoute>[0]

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY             ?? 'demo',
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN         ?? 'demo.firebaseapp.com',
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID          ?? 'demo',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '000000',
  appId:             import.meta.env.VITE_FIREBASE_APP_ID              ?? '1:000000:web:demo',
}

precacheAndRoute((self as unknown as { __WB_MANIFEST: PrecacheManifest }).__WB_MANIFEST)
cleanupOutdatedCaches()

// LINE Seed JP was removed from the app shell. Its named runtime cache is not
// managed by cleanupOutdatedCaches(), so remove the legacy payload once when
// the new worker activates instead of leaving the old CJK subsets on device.
sw.addEventListener('activate', event => {
  event.waitUntil(caches.delete('google-fonts-cache'))
})

sw.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void sw.skipWaiting()
  }
})

// SPA fallback. /__/auth/* is served by Cloudflare Pages Functions and must
// bypass the app shell or Firebase Auth redirect returns become client 404s.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/__\/auth\//],
  }),
)

registerRoute(
  ({ url }) => url.origin === sw.location.origin && /\/assets\/vendor-sentry-.*\.js$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'vendor-sentry-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries:    3,
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
)

registerRoute(
  ({ url }) => url.origin === sw.location.origin
    && /\/assets\/vendor-firebase-.*\.js$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'vendor-firebase-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries:    10,
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
)

registerRoute(
  ({ url }) => url.origin === sw.location.origin && /\/assets\/jsQR-.*\.js$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'qr-scanner-fallback-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries:    2,
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
)

registerRoute(
  ({ url }) => url.origin === sw.location.origin
    && /\/assets\/(?:vendor-(?:pdfjs|react-pdf)-.*\.js|PdfPreview-.*\.js|pdf\.worker\.min-.*\.mjs)$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'pdf-runtime-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 4,
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
)

registerRoute(
  ({ url }) => url.origin === sw.location.origin
    && /\/assets\/(?:mapbox-gl|RoutePreviewMap)-.*\.(?:js|css)$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'route-map-assets-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries:    6,
        maxAgeSeconds: 10 * 24 * 60 * 60,
      }),
    ],
  }),
)

// Lazy route/debug chunks excluded from install-time precache are immutable
// hashed assets. Cache after first use so revisits and offline sessions remain
// fast without making every fresh install download every tab up front.
// Keep this restricted to hashed /assets JS/CSS: /compatibility.json is an
// operational write gate and must never enter a runtime cache.
registerRoute(
  ({ url }) => url.origin === sw.location.origin
    && /\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'lazy-static-assets-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 80,
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
)

function toSameOriginUrl(raw: unknown): string {
  const fallback = new URL('/schedule', sw.location.origin)
  if (typeof raw !== 'string' || raw.length > 300) return fallback.href

  try {
    const url = new URL(raw, sw.location.origin)
    return url.origin === sw.location.origin ? url.href : fallback.href
  } catch {
    return fallback.href
  }
}

function getNotificationUrl(payload: MessagePayload): string {
  return toSameOriginUrl(payload.data?.url ?? payload.fcmOptions?.link)
}

function getTag(payload: MessagePayload): string {
  const raw = payload.data?.tag ?? payload.messageId
  return raw ? `tripmate-${raw.slice(0, 80)}` : 'tripmate-update'
}

async function shouldDisplayForCurrentOwner(payload: MessagePayload): Promise<boolean> {
  const targetUid = payload.data?.targetUid
  // Phase A deploy order: old Functions may still emit payloads without
  // targetUid. Fail open for missing targetUid; fail closed once a target is
  // present and it does not match this browser's current signed-in user.
  if (!targetUid) return true
  return await readPushOwnerUid() === targetUid
}

async function showDataNotification(payload: MessagePayload): Promise<void> {
  // Notification payloads are displayed by the FCM SDK/browser path. Showing
  // them again here creates duplicate system notifications; data-only payloads
  // are the server contract for custom TripMate notifications.
  if (payload.notification) return

  const body = payload.data?.body
  if (!body) return
  if (!await shouldDisplayForCurrentOwner(payload)) return

  await sw.registration.showNotification(payload.data?.title ?? 'TripMate', {
    body,
    icon:  '/pwa-192x192.png',
    badge: '/favicon-32x32.png',
    tag:   getTag(payload),
    data:  { url: getNotificationUrl(payload) },
  })
}

try {
  const app = initializeApp(firebaseConfig)
  onBackgroundMessage(getMessaging(app), showDataNotification)
} catch {
  // Non-fatal: unsupported / blocked SW messaging should not break offline.
}

sw.addEventListener('notificationclick', event => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  const targetUrl = toSameOriginUrl(data?.url)

  event.waitUntil((async () => {
    const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => new URL(client.url).origin === sw.location.origin)
    if (existing) {
      const navigated = existing.url === targetUrl
        ? existing
        : await existing.navigate(targetUrl).catch(() => existing)
      await (navigated ?? existing).focus()
      return
    }

    await sw.clients.openWindow(targetUrl)
  })())
})
