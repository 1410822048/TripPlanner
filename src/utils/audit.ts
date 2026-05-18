// src/utils/audit.ts
// Single source of truth for the {createdBy, updatedBy, createdAt, updatedAt}
// blob written on every feature-entity write. Catches "added a new audit
// field but forgot one site" drift. If we ever extend the blob (e.g.
// updatedDevice for cross-device debugging), it changes here only.
//
// Service paths pass serverTimestamp() from getFirebase(); hook optimistic
// patches and mock fixtures use MOCK_TIMESTAMP. See useFeatureBadges for
// how updatedBy drives the tab unread-dot filter.
import type { FieldValue, Timestamp } from 'firebase/firestore'
import { MOCK_TIMESTAMP } from '@/mocks/utils'

type AuditTime = FieldValue | Timestamp

// Generic over the timestamp shape so MOCK_TIMESTAMP variants stay
// strictly typed as Timestamp (cache shape) while service variants
// keep the FieldValue sentinel type (addDoc / updateDoc payload).
export function auditCreate<T extends AuditTime>(uid: string, ts: T) {
  return { createdBy: uid, updatedBy: uid, createdAt: ts, updatedAt: ts }
}

export function auditUpdate<T extends AuditTime>(uid: string, ts: T) {
  return { updatedBy: uid, updatedAt: ts }
}

export const auditCreateMock = (uid: string) => auditCreate(uid, MOCK_TIMESTAMP)
export const auditUpdateMock = (uid: string) => auditUpdate(uid, MOCK_TIMESTAMP)

/** Frozen demo audit blob — spread into fixtures in src/features/*\/mocks.ts. */
export const DEMO_AUDIT = { ...auditCreateMock('demo'), memberIds: ['demo'] as string[] }
