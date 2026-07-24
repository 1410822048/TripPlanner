import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

const projectId = process.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-tripmate'
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'

const ROLE_USERS = [
  { uid: 'dev-owner', email: 'dev-owner@localhost.test', displayName: 'DEV owner', role: 'owner' },
  { uid: 'dev-editor', email: 'dev-editor@localhost.test', displayName: 'DEV editor', role: 'editor' },
  { uid: 'dev-viewer', email: 'dev-viewer@localhost.test', displayName: 'DEV viewer', role: 'viewer' },
]
const password = process.env.VITE_DEV_EMULATOR_PASSWORD ?? 'tripmate-dev-password'
const tripId = 'dev-route-trip'
const date = '2026-07-15'
const now = Timestamp.now()

const app = getApps()[0] ?? initializeApp({ projectId })
const auth = getAuth(app)
const db = getFirestore(app)

for (const account of ROLE_USERS) {
  try { await auth.deleteUser(account.uid) } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error
  }
  await auth.createUser({
    uid: account.uid,
    email: account.email,
    password,
    displayName: account.displayName,
    emailVerified: true,
  })
}

const memberIds = ROLE_USERS.map(account => account.uid)
const tripRef = db.doc(`trips/${tripId}`)
await tripRef.set({
  title: 'Route preview emulator trip',
  destination: 'Tokyo, Japan',
  icon: '✈️',
  startDate: Timestamp.fromDate(new Date(`${date}T00:00:00.000Z`)),
  endDate: Timestamp.fromDate(new Date(`${date}T23:59:59.000Z`)),
  currency: 'JPY',
  defaultCountryCode: 'JP',
  ownerId: 'dev-owner',
  memberIds,
  wishVotingDeadlineAt: null,
  wishVotingDeadlineNotifiedAt: null,
  createdAt: now,
  updatedAt: now,
})

for (const account of ROLE_USERS) {
  await db.doc(`trips/${tripId}/members/${account.uid}`).set({
    tripId,
    userId: account.uid,
    displayName: account.displayName,
    role: account.role,
    joinedAt: now,
    memberIds,
  })
}

const places = [
  { providerPlaceId: 'geo-narita', name: 'Narita Airport', address: 'Narita, Chiba, Japan', lat: 35.772, lng: 140.3929, countryCode: 'JP' },
  { providerPlaceId: 'geo-asakusa', name: 'Asakusa Station', address: 'Taito City, Tokyo, Japan', lat: 35.711, lng: 139.796, countryCode: 'JP' },
  { providerPlaceId: 'geo-shinjuku', name: 'Shinjuku Station', address: 'Shinjuku, Tokyo, Japan', lat: 35.6896, lng: 139.7006, countryCode: 'JP' },
]
const schedules = [
  { id: 'route-1', order: 0, title: 'Arrive at Narita', startTime: '09:00', timeMode: 'preferred', durationMinutes: 60, place: places[0] },
  { id: 'route-2', order: 1, title: 'Asakusa Station', timeMode: 'flexible', durationMinutes: 60, place: places[1] },
  { id: 'route-3', order: 2, title: 'Shinjuku reservation', startTime: '17:00', timeMode: 'fixed', durationMinutes: 60, place: places[2] },
]
for (const schedule of schedules) {
  const { id, place, ...rest } = schedule
  await db.doc(`trips/${tripId}/schedules/${schedule.id}`).set({
    tripId,
    date,
    ...rest,
    location: { status: 'resolved', place: { provider: 'geoapify', ...place, timeZone: 'Asia/Tokyo' } },
    category: 'activity',
    description: '',
    estimatedCostMinor: 0,
    routeRevision: null,
    createdBy: 'dev-owner',
    updatedBy: 'dev-owner',
    memberIds,
    createdAt: now,
    updatedAt: now,
  })
}

console.log(JSON.stringify({ projectId, tripId, date, users: ROLE_USERS.map(({ uid, email, role }) => ({ uid, email, role })) }, null, 2))
