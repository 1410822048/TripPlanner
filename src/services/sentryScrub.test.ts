// Invite tokens live in the URL fragment (/invite/:tripId#token). Sentry's
// default integrations attach location.href to events and breadcrumbs, so
// the scrubbers must strip fragments before anything leaves the device.
import { describe, expect, it } from 'vitest'
import { scrubSentryBreadcrumb, scrubSentryEvent, stripUrlFragment } from './sentry'

describe('sentry URL scrubbing', () => {
  it('strips the fragment and keeps the rest of the URL', () => {
    expect(stripUrlFragment('https://app.test/invite/t1#secret-token')).toBe('https://app.test/invite/t1')
    expect(stripUrlFragment('https://app.test/schedule?x=1')).toBe('https://app.test/schedule?x=1')
  })

  it('scrubs request.url and embedded breadcrumbs on events', () => {
    const event = scrubSentryEvent({
      request:     { url: 'https://app.test/invite/t1#tok' },
      breadcrumbs: [{ data: { from: '/invite/t1#tok', to: '/schedule' } }],
    })
    expect(event.request?.url).toBe('https://app.test/invite/t1')
    expect(event.breadcrumbs?.[0]?.data).toEqual({ from: '/invite/t1', to: '/schedule' })
  })

  it('scrubs navigation / fetch breadcrumbs', () => {
    expect(scrubSentryBreadcrumb({ data: { url: 'https://app.test/invite/t1#tok' } }).data)
      .toEqual({ url: 'https://app.test/invite/t1' })
    const click: { message: string; data?: Record<string, unknown> } = { message: 'click' }
    expect(scrubSentryBreadcrumb(click)).toEqual({ message: 'click' })
  })
})
