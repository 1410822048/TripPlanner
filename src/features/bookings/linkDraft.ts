// src/features/bookings/linkDraft.ts
// Reservation URL/share-target normalisation. Kept separate from utils.ts so
// lightweight display helpers (thumbnail paths, labels) do not pull the brand
// catalog unless a form/import flow actually needs URL -> draft inference.
import { isHttpUrl, type Booking } from '@/types/booking'
import { bookingProviderFromUrl } from './utils'
import { bookingPlatformBrand } from './components/cards/brandMeta'

export type BookingLinkDraft = Pick<Booking, 'type'> & {
  title:    string
  provider: string
  link:     string
}

export type SharedBookingDraft = {
  key:   string
  draft: BookingLinkDraft
}

function boundedText(value: string | null | undefined, max: number): string {
  return (value ?? '').trim().slice(0, max)
}

function cleanSharedUrl(value: string | null | undefined): string {
  const url = (value ?? '').trim()
  return url.length <= 500 && isHttpUrl(url) ? url : ''
}

function firstUrlInText(text: string | null | undefined): string {
  const value = text ?? ''
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = match[0].replace(/[),.。]+$/g, '')
    if (url.length <= 500 && isHttpUrl(url)) return url
  }
  return ''
}

// Multi-vertical OTAs (Agoda / Booking / Trip.com / Expedia) sell flights too
// under the same host, so a matched platform alone can't mean "hotel" — only a
// lodging path (`/hotel`, `/rooms`, …) qualifies them. Host markers are limited
// to lodging-EXCLUSIVE platforms (Airbnb / Vrbo) that have no flight vertical.
// Otherwise stay generic (`other`) — an editable default beats a wrong
// specialized type. ponytail: substring markers, widen the list if a platform's
// lodging URLs start slipping through to `other`.
const LODGING_URL_MARKER = /hotel|airbnb|vrbo|\/rooms|ryokan|旅館|民宿|ホテル|lodging|hostel|voucher/i

function titleFromShare(title: string | null | undefined, text: string | null | undefined, link: string, provider: string): string {
  const explicit = boundedText(title, 100)
  if (explicit && explicit !== link) return explicit

  const textTitle = boundedText((text ?? '').replace(link, ''), 100)
  if (textTitle && textTitle !== link) return textTitle

  return boundedText(provider || '訂單頁面', 100)
}

export function sharedBookingUrl(url: string | null | undefined, text: string | null | undefined): string {
  return cleanSharedUrl(url) || firstUrlInText(text)
}

export function hasShareParams(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('url') || params.has('text') || params.has('title')
}

export function deriveBookingLinkDraft(input: {
  link:   string
  title?: string | null
  text?:  string | null
}): BookingLinkDraft | null {
  const link = cleanSharedUrl(input.link)
  const titleHint = boundedText(input.title, 100)
  const textHint  = boundedText(input.text, 100)
  if (!link && !titleHint && !textHint) return null

  const provider = bookingProviderFromUrl(link)
  const platform = bookingPlatformBrand(provider)
  const providerLabel = platform?.name ?? provider

  return {
    type:     platform && LODGING_URL_MARKER.test(link) ? 'hotel' : 'other',
    title:    titleFromShare(input.title, input.text, link, providerLabel),
    provider: providerLabel,
    link,
  }
}

export function sharedBookingDraftFromSearch(search: string): SharedBookingDraft | null {
  const params = new URLSearchParams(search)
  const text = params.get('text')
  const link = sharedBookingUrl(params.get('url'), text)
  const draft = deriveBookingLinkDraft({
    link,
    title: params.get('title'),
    text,
  })
  if (!draft) return null

  return {
    key: `share:${draft.link || draft.title || Date.now()}`,
    draft,
  }
}
