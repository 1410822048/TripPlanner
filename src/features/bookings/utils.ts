// src/features/bookings/utils.ts
// Shared display helpers — keeps the list, preview modal, and any future
// booking renderer in lockstep when the schema gains optional fields.
import type { Booking } from '@/types'

/**
 * Primary user-facing label for a booking. Transport types prefer the
 * "出発 → 到着" route; everything else uses the title. Falls back to a
 * generic word when neither is set so the UI never renders an empty header.
 */
export function bookingDisplayName(b: Booking): string {
  if (b.origin && b.destination) return `${b.origin} → ${b.destination}`
  if (b.title) return b.title
  return '予約'
}

/**
 * Subtitle for transport bookings. Includes the vehicle name (flight
 * number / train name → stored as `title`) and the provider, separated
 * by middle dots. Returns an empty string if neither piece is set so the
 * caller can decide to omit the row entirely.
 */
export function bookingSubtitle(b: Booking): string {
  const parts: string[] = []
  // For transport, title acts as the vehicle name; show alongside provider.
  // For non-transport, title is already the primary header → don't repeat.
  const isTransport = b.type === 'flight' || b.type === 'train' || b.type === 'bus'
  if (isTransport && b.title) parts.push(b.title)
  if (b.provider) parts.push(b.provider)
  return parts.join(' · ')
}
