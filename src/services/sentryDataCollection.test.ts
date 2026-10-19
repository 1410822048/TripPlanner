// @vitest-environment jsdom
// Sentry 11 collects user info, cookies and every header by default.
// Drive the real SDK with our options and a capturing transport, and check
// what an error event would actually carry off the device.
import { describe, expect, it } from 'vitest'
import { BrowserClient, Scope, defaultStackParser, getDefaultIntegrations } from '@sentry/browser'
import type { BrowserOptions, Event } from '@sentry/browser'
import { SENTRY_DATA_COLLECTION, scrubSentryEvent } from './sentry'

type Envelope = Parameters<ReturnType<NonNullable<BrowserOptions['transport']>>['send']>[0]

async function captureOnce(): Promise<Event> {
  const sent: Envelope[] = []
  const client = new BrowserClient({
    dsn:            'https://public@o0.ingest.sentry.io/1',
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend:     event => scrubSentryEvent(event),
    integrations:   getDefaultIntegrations({}),
    stackParser:    defaultStackParser,
    transport:      () => ({
      send:  async envelope => { sent.push(envelope); return {} },
      flush: async () => true,
    }),
  })
  const scope = new Scope()
  scope.setClient(client)
  client.init()
  document.cookie = 'session=secret-cookie'
  client.captureException(new Error('boom'), undefined, scope)
  await client.flush(1000)
  const [, items] = sent[0]!
  return items.find(([item]) => item.type === 'event')![1] as Event
}

describe('sentry data collection', () => {
  it('sends only User-Agent, no cookies, no user and no IP inference', async () => {
    window.history.replaceState(null, '', '/invite/t1#secret-token')
    const event = await captureOnce()

    expect(Object.keys(event.request?.headers ?? {})).toEqual(['User-Agent'])
    expect(event.request?.cookies).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('secret-cookie')
    expect(event.user).toBeUndefined()
    expect(event.sdk?.settings?.infer_ip).toBe('never')
    expect(event.request?.url).not.toContain('secret-token')
  })
})
