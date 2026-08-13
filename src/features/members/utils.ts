// src/features/members/utils.ts
// Firestore `Member` → UI `TripMember` conversion.
// UI rows expect a pre-computed avatar chip (label + color pair). We derive
// these deterministically from the member id so chips stay stable across
// renders and reloads, without persisting presentation data to Firestore.
import type { Member } from '@/types'
import type { TripMember } from '@/features/trips/types'

// Curated palette — same visual weight as DEMO_MEMBERS in trips/mocks.ts.
// Ordered so the first few slots match existing demo colours for continuity.
const CHIP_PALETTE: { color: string; bg: string }[] = [
  { color: '#3A7858', bg: '#C6DDD6' },
  { color: '#4A6FA0', bg: '#BDC9DC' },
  { color: '#9A6840', bg: '#DDC9B2' },
  { color: '#724888', bg: '#CEBEDD' },
  { color: '#A85A5A', bg: '#E2C5C5' },
  { color: '#5A7A4A', bg: '#D0DCC2' },
]

function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** First grapheme of displayName (handles surrogate pairs / CJK / emoji). */
function firstGrapheme(s: string): string {
  const trimmed = s.trim()
  if (!trimmed) return '?'
  // Intl.Segmenter is widely supported (Safari 14.1+, all evergreens).
  // Fallback to codePointAt for exotic environments.
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const first = seg.segment(trimmed)[Symbol.iterator]().next().value
    if (first) return first.segment
  }
  const cp = trimmed.codePointAt(0)
  return cp ? String.fromCodePoint(cp) : (trimmed[0] ?? '?')
}

/** Hard cap on a member's stored displayName. Mirrored in three places that
 *  must not drift: `MemberDocSchema`, the owner-bootstrap rule in
 *  firestore.rules, and the Worker's invite-redeem schema. The member-strip
 *  copies this name onto `trip.formerMemberNames`, whose value cap is the
 *  same number — a longer name there makes the whole trip doc unparseable. */
const MEMBER_NAME_MAX = 100

/**
 * Normalize a Firebase Auth displayName into something the member-create
 * rule will accept.
 *
 * Two failure modes it exists to prevent, both of which reject the ENTIRE
 * atomic batch (trip + owner member doc) and surface as an opaque 403:
 *
 *   - empty / whitespace-only — `??` does not catch `''`, and Auth can hand
 *     one back.
 *   - over the cap — truncation is by CODE POINT, not `slice()`. Slicing at
 *     a UTF-16 boundary splits an emoji's surrogate pair and Firestore
 *     persists the lone half as U+FFFD, silently corrupting the name.
 */
export function normalizeMemberDisplayName(raw: string | null | undefined): string {
  const source = raw?.trim()
  if (!source) return 'Me'
  if (source.length <= MEMBER_NAME_MAX) return source
  let out = ''
  for (const ch of source) {
    if (out.length + ch.length > MEMBER_NAME_MAX) break
    out += ch
  }
  return out || 'Me'
}

export function memberToTripMember(m: Member): TripMember {
  // CHIP_PALETTE is a non-empty constant, so modulo always yields a valid slot.
  const { color, bg } = CHIP_PALETTE[hashId(m.id) % CHIP_PALETTE.length]!
  return {
    id:          m.id,
    displayName: m.displayName,
    avatarLabel: firstGrapheme(m.displayName),
    color,
    bg,
    avatarUrl:   m.avatarUrl,
  }
}

export function membersToTripMembers(members: Member[]): TripMember[] {
  return members.map(memberToTripMember)
}
