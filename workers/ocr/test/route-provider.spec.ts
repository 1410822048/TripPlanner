import { describe, expect, test, vi } from 'vitest'
import {
  cleanGoogleMapsPlaceQuery,
  dedupePlaceCandidates,
  geoapifyForwardGeocode,
  geoapifyAutocompleteWithAliases,
  normalizePlaceQuery,
  orsDirections,
  orsMatrix,
  parseGeoapifyFeatures,
  parseOrsDirectionsResponse,
  parseOrsMatrixResponse,
  resolveGoogleMapsUrl,
  safeGoogleMapsQuery,
} from '../src/route-provider'

const points = [
  { lat: 35, lng: 139 },
  { lat: 35.01, lng: 139.01 },
  { lat: 35.02, lng: 139.02 },
]

describe('route provider fixtures', () => {
  test('searches the explicit Japanese alias first and retries the raw query once', async () => {
    const requestedQueries: string[] = []
    const requestedBiases: string[] = []
    const requestedLanguages: string[] = []
    const results = await geoapifyAutocompleteWithAliases(
      '江之島',
      { GEOAPIFY_API_KEY: 'test-key' },
      async input => {
        const query = new URL(String(input)).searchParams.get('text') ?? ''
        const url = new URL(String(input))
        requestedBiases.push(url.searchParams.get('bias') ?? '')
        requestedLanguages.push(url.searchParams.get('lang') ?? '')
        requestedQueries.push(query)
        return new Response(JSON.stringify({
          features: query === '江ノ島' ? [{ properties: {
            place_id: 'enoshima',
            name: '藤沢市',
            suburb: '江の島',
            city: '藤沢市',
            result_type: 'suburb',
            formatted: '藤沢市, 江の島, 日本',
            lat: 35.299,
            lon: 139.481,
            timezone: { name: 'Asia/Tokyo' }, country_code: 'jp',
          } }] : [],
        }), { status: 200 })
      }, { normalizationCountryCode: 'JP', biasCountryCode: 'JP' },
    )

    expect(requestedQueries).toEqual(['江ノ島'])
    expect(requestedBiases).toEqual(['countrycode:jp'])
    expect(requestedLanguages).toEqual(['ja'])
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ providerPlaceId: 'enoshima', name: '江の島', countryCode: 'JP' })
  })

  test('does not force a Geoapify language from a weak country bias', async () => {
    let requestedLanguage: string | null = null
    await geoapifyAutocompleteWithAliases(
      'Enoshima',
      { GEOAPIFY_API_KEY: 'test-key' },
      async input => {
        requestedLanguage = new URL(String(input)).searchParams.get('lang')
        return new Response(JSON.stringify({ features: [] }), { status: 200 })
      },
      { biasCountryCode: 'JP' },
    )

    expect(requestedLanguage).toBeNull()
  })

  test('requests Japanese results when forward geocoding in an explicit JP context', async () => {
    let requestedLanguage: string | null = null
    await geoapifyForwardGeocode(
      '江ノ島',
      { GEOAPIFY_API_KEY: 'test-key' },
      async input => {
        requestedLanguage = new URL(String(input)).searchParams.get('lang')
        return new Response(JSON.stringify({ features: [] }), { status: 200 })
      },
      { normalizationCountryCode: 'JP', biasCountryCode: 'JP' },
    )

    expect(requestedLanguage).toBe('ja')
  })

  test('retries the raw query only when the normalized Japanese query is empty', async () => {
    const queries: string[] = []
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ features: [{ properties: {
      place_id: 'original',
      name: '江之島',
      lat: 35.299,
      lon: 139.481,
      timezone: { name: 'Asia/Tokyo' },
      country_code: 'jp',
    } }] }), { status: 200 }))

    const results = await geoapifyAutocompleteWithAliases(
      '長谷站',
      { GEOAPIFY_API_KEY: 'test-key' },
      async (input, init) => {
        queries.push(new URL(String(input)).searchParams.get('text') ?? '')
        if (queries.length === 1) return new Response(JSON.stringify({ features: [] }), { status: 200 })
        return fetchImpl(input, init)
      },
      { normalizationCountryCode: 'JP', biasCountryCode: 'JP' },
    )

    expect(queries).toEqual(['長谷駅', '長谷站'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(results[0]?.providerPlaceId).toBe('original')
  })

  test('normalizes only explicit JP station suffixes and exact Enoshima aliases', () => {
    expect(normalizePlaceQuery('長谷站', 'JP')).toBe('長谷駅')
    expect(normalizePlaceQuery('長谷車站', 'JP')).toBe('長谷駅')
    expect(normalizePlaceQuery('台北站', 'TW')).toBe('台北站')
    expect(normalizePlaceQuery('江之島', 'JP')).toBe('江ノ島')
    expect(normalizePlaceQuery('江の島', 'JP')).toBe('江ノ島')
    expect(normalizePlaceQuery('鐮倉駅', 'JP')).toBe('鎌倉駅')
    expect(normalizePlaceQuery('鐮倉駅', 'TW')).toBe('鐮倉駅')
    expect(normalizePlaceQuery('星のや東京', 'JP')).toBe('星のや東京')
  })

  test('parses a square ORS matrix and converts durations to minutes', () => {
    expect(parseOrsMatrixResponse({
      durations: [[0, 900], [840, 0]],
      distances: [[0, 1200], [1100, 0]],
    }, 2)).toEqual({
      durationsMinutes: [[0, 15], [14, 0]],
      distancesMeters: [[0, 1200], [1100, 0]],
    })
  })

  test('rejects a malformed or non-square ORS matrix', () => {
    expect(() => parseOrsMatrixResponse({
      durations: [[0, 1]],
      distances: [[0, 1]],
    }, 2)).toThrow(/matrix/i)
  })

  test('requests one ORS walking matrix for all schedule locations', async () => {
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    await orsMatrix(points, { ORS_API_KEY: 'test-key' }, async (input, init) => {
      requestedUrl = String(input)
      requestedInit = init
      return new Response(JSON.stringify({
        durations: [[0, 60, 120], [60, 0, 60], [120, 60, 0]],
        distances: [[0, 100, 200], [100, 0, 100], [200, 100, 0]],
      }), { status: 200 })
    })

    expect(requestedUrl).toBe('https://api.openrouteservice.org/v2/matrix/foot-walking')
    expect(requestedInit?.method).toBe('POST')
    expect(new Headers(requestedInit?.headers).get('Authorization')).toBe('test-key')
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      locations: [[139, 35], [139.01, 35.01], [139.02, 35.02]],
      metrics: ['distance', 'duration'],
    })
  })

  test('reuses a short-lived hashed Cache API entry for identical ORS matrix input', async () => {
    const stored = new Map<string, Response>()
    const cache = {
      match: vi.fn(async (request: RequestInfo | URL) => stored.get(String(request))?.clone()),
      put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
        stored.set(String(request), response.clone())
      }),
    }
    const pending: Promise<unknown>[] = []
    const runtime = {
      cache,
      cacheOrigin: 'https://worker.example.test/route-preview',
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      durations: [[0, 60, 120], [60, 0, 60], [120, 60, 0]],
      distances: [[0, 100, 200], [100, 0, 100], [200, 100, 0]],
    }), { status: 200 }))

    await orsMatrix(points, { ORS_API_KEY: 'test-key' }, fetchImpl, undefined, runtime)
    await Promise.all(pending)
    await orsMatrix(points, { ORS_API_KEY: 'test-key' }, fetchImpl, undefined, runtime)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledTimes(1)
    const cacheRequest = cache.put.mock.calls[0]?.[0]
    expect(cacheRequest).toBeInstanceOf(Request)
    expect((cacheRequest as Request).method).toBe('GET')
    expect(String(cacheRequest)).not.toContain('139')
    expect(String(cacheRequest)).not.toContain('test-key')
  })

  test('rejects an oversized provider response before buffering its body', async () => {
    await expect(orsMatrix(points, { ORS_API_KEY: 'test-key' }, async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Length': '2000001' },
    }))).rejects.toMatchObject({ status: 502 })
  })

  test('splits one ORS GeoJSON route into per-leg geometry using way_points', () => {
    const result = parseOrsDirectionsResponse({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          summary: { duration: 1800, distance: 3000 },
          segments: [
            { duration: 600, distance: 1000 },
            { duration: 1200, distance: 2000 },
          ],
          way_points: [0, 2, 4],
        },
        geometry: {
          type: 'LineString',
          coordinates: [[139, 35], [139.005, 35.005], [139.01, 35.01], [139.015, 35.015], [139.02, 35.02]],
        },
      }],
    })

    expect(result.durationMinutes).toBe(30)
    expect(result.legs).toEqual([
      {
        durationMinutes: 10,
        distanceMeters: 1000,
        coordinates: [[139, 35], [139.005, 35.005], [139.01, 35.01]],
      },
      {
        durationMinutes: 20,
        distanceMeters: 2000,
        coordinates: [[139.01, 35.01], [139.015, 35.015], [139.02, 35.02]],
      },
    ])
  })

  test('requests one ORS Directions route for the final ordered locations', async () => {
    let requestedBody: unknown
    await orsDirections(points, { ORS_API_KEY: 'test-key' }, async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {
            summary: { duration: 120, distance: 200 },
            segments: [{ duration: 60, distance: 100 }, { duration: 60, distance: 100 }],
            way_points: [0, 1, 2],
          },
          geometry: { type: 'LineString', coordinates: [[139, 35], [139.01, 35.01], [139.02, 35.02]] },
        }],
      }), { status: 200 })
    })

    expect(requestedBody).toEqual({
      coordinates: [[139, 35], [139.01, 35.01], [139.02, 35.02]],
    })
  })

  test('normalizes Geoapify features to PlaceRef candidates', () => {
    const result = parseGeoapifyFeatures([{ properties: {
      place_id: 'p1', name: 'Tokyo Tower', formatted: 'Tokyo Tower, Japan', lat: 35.6586, lon: 139.7454,
      timezone: { name: 'Asia/Tokyo' },
      country_code: 'jp',
    } }])
    expect(result[0]).toMatchObject({ provider: 'geoapify', providerPlaceId: 'p1', lat: 35.6586, lng: 139.7454, timeZone: 'Asia/Tokyo', countryCode: 'JP' })
  })

  test('uses the most specific official field matching the normalized query instead of an administrative city', () => {
    const result = parseGeoapifyFeatures([{ properties: {
      place_id: 'enoshima-locality',
      name: '藤沢市',
      address_line1: '藤沢市',
      suburb: '江の島二丁目',
      district: '藤沢地区',
      city: '藤沢市',
      result_type: 'suburb',
      formatted: '藤沢市, 江の島二丁目 251-0036, 日本',
      lat: 35.299,
      lon: 139.481,
      timezone: { name: 'Asia/Tokyo' },
      country_code: 'jp',
    } }], '江ノ島')

    expect(result[0]).toMatchObject({
      name: '江の島二丁目',
      address: '藤沢市, 江の島二丁目 251-0036, 日本',
    })
  })

  test('keeps a matching POI name ahead of its containing locality', () => {
    const result = parseGeoapifyFeatures([{ properties: {
      place_id: 'enoden',
      name: '江ノ島電鉄 江ノ島駅',
      address_line1: '江ノ島電鉄 江ノ島駅',
      suburb: '片瀬海岸一丁目',
      city: '藤沢市',
      result_type: 'amenity',
      formatted: '江ノ島電鉄 江ノ島駅, 藤沢市, 日本',
      lat: 35.311,
      lon: 139.487,
      timezone: { name: 'Asia/Tokyo' },
      country_code: 'jp',
    } }], '江ノ島電鉄')

    expect(result[0]?.name).toBe('江ノ島電鉄 江ノ島駅')
  })

  test('does not fuse a nearby station alias into an unrelated Japanese candidate', () => {
    const shared = { provider: 'geoapify' as const, timeZone: 'Asia/Tokyo', countryCode: 'JP' }
    const result = dedupePlaceCandidates([
      { ...shared, providerPlaceId: 'shop', name: '観光案内所', lat: 35.31103, lng: 139.48753 },
      { ...shared, providerPlaceId: 'station', name: 'Enoshima Eki', lat: 35.31103, lng: 139.48763 },
    ], '江ノ島')

    expect(result.map(candidate => candidate.name)).toEqual(['観光案内所', 'Enoshima Eki'])
  })

  test('localizes a station alias when Geoapify omits the Japanese station suffix', () => {
    const shared = { provider: 'geoapify' as const, timeZone: 'Asia/Tokyo', countryCode: 'JP' }
    const result = dedupePlaceCandidates([
      { ...shared, providerPlaceId: 'local', name: '鎌倉高校前', lat: 35.30674, lng: 139.50054 },
      { ...shared, providerPlaceId: 'station', name: 'Kamakura Kōkōmae Eki', lat: 35.30677, lng: 139.50058 },
    ], '鎌倉高校前駅')

    expect(result.map(candidate => candidate.name)).toEqual(['鎌倉高校前駅'])
  })

  test('does not turn a Japanese postal address into a station name from a pin hint', () => {
    const shared = { provider: 'geoapify' as const, timeZone: 'Asia/Tokyo', countryCode: 'JP' }
    const exact = { lat: 35.30672, lng: 139.50056 }
    const result = dedupePlaceCandidates([
      { ...shared, providerPlaceId: 'station', name: 'Kamakura Kōkōmae Eki', ...exact },
    ], '神奈川県鎌倉市腰越', exact)

    expect(result[0]?.name).toBe('Kamakura Kōkōmae Eki')
  })

  test('does not apply a Google pin label to a station candidate over 30 metres away', () => {
    const shared = { provider: 'geoapify' as const, timeZone: 'Asia/Tokyo', countryCode: 'JP' }
    const exact = { lat: 35.30672, lng: 139.50056 }
    const result = dedupePlaceCandidates([
      { ...shared, providerPlaceId: 'station', name: 'Kamakura Kōkōmae Eki', lat: 35.30708, lng: 139.50056 },
    ], '鎌倉高校前', exact)

    expect(result[0]?.name).toBe('Kamakura Kōkōmae Eki')
  })

  test('does not duplicate the Japanese station suffix from a Google pin label', () => {
    const shared = { provider: 'geoapify' as const, timeZone: 'Asia/Tokyo', countryCode: 'JP' }
    const exact = { lat: 35.30672, lng: 139.50056 }
    const result = dedupePlaceCandidates([
      { ...shared, providerPlaceId: 'station', name: 'Kamakura Kōkōmae Eki', ...exact },
    ], '鎌倉高校前駅', exact)

    expect(result[0]?.name).toBe('鎌倉高校前駅')
  })

  test('keeps mixed Latin and Japanese characters in a Google station pin label', () => {
    const shared = { provider: 'geoapify' as const, timeZone: 'Asia/Tokyo', countryCode: 'JP' }
    const exact = { lat: 35.212, lng: 139.685 }
    const result = dedupePlaceCandidates([
      { ...shared, providerPlaceId: 'station', name: 'YRP Nobi Eki', ...exact },
    ], 'YRP野比', exact)

    expect(result[0]?.name).toBe('YRP野比駅')
  })

  test('does not fuse a matching Japanese candidate with a distant station alias', () => {
    const shared = { provider: 'geoapify' as const, timeZone: 'Asia/Tokyo', countryCode: 'JP' }
    const result = dedupePlaceCandidates([
      { ...shared, providerPlaceId: 'local', name: '江ノ島', lat: 35.31103, lng: 139.48753 },
      { ...shared, providerPlaceId: 'station', name: 'Enoshima Eki', lat: 35.31143, lng: 139.48753 },
    ], '江ノ島')

    expect(result.map(candidate => candidate.name)).toEqual(['江ノ島', 'Enoshima Eki'])
  })

  test('falls back to the provider name when no structured field matches the query', () => {
    const result = parseGeoapifyFeatures([{ properties: {
      place_id: 'fallback',
      name: '藤沢市',
      city: '藤沢市',
      result_type: 'city',
      lat: 35.34,
      lon: 139.49,
      timezone: { name: 'Asia/Tokyo' },
      country_code: 'jp',
    } }], '鎌倉大仏')

    expect(result[0]?.name).toBe('藤沢市')
  })

  test('ranks exact, prefix, name-contained, and address-only matches while preserving provider order for ties', () => {
    const place = (placeId: string, name: string, formatted: string) => ({ properties: {
      place_id: placeId,
      name,
      formatted,
      lat: 35.31,
      lon: 139.53,
      timezone: { name: 'Asia/Tokyo' },
      country_code: 'jp',
    } })
    const result = parseGeoapifyFeatures([
      place('unmatched-first', '門司区', '門司区, 長谷一丁目, 日本'),
      place('address-only', '観光案内所', '観光案内所, 長谷駅, 鎌倉市, 日本'),
      place('name-contained', '江ノ電 長谷駅 西口', '江ノ電 長谷駅 西口, 鎌倉市, 日本'),
      place('prefix', '長谷駅前案内所', '長谷駅前案内所, 鎌倉市, 日本'),
      place('exact', '長谷駅', '長谷駅, 鎌倉市, 日本'),
      place('unmatched-second', '沼田東町七宝', '沼田東町七宝, 三原市, 日本'),
    ], '長谷駅')

    expect(result.map(candidate => candidate.providerPlaceId)).toEqual([
      'exact',
      'prefix',
      'name-contained',
      'address-only',
      'unmatched-first',
      'unmatched-second',
    ])
  })

  test('does not fabricate UTC when Geoapify omits an IANA time zone', () => {
    const result = parseGeoapifyFeatures([{ properties: {
      place_id: 'p-no-zone', name: 'Unknown place', lat: 35, lon: 139,
    } }])
    expect(result).toEqual([])
  })

  test('drops candidates whose country code is absent or invalid', () => {
    expect(parseGeoapifyFeatures([{ properties: {
      place_id: 'missing-country', name: 'Unknown', lat: 35, lon: 139,
      timezone: { name: 'Asia/Tokyo' },
    } }])).toEqual([])
    expect(parseGeoapifyFeatures([{ properties: {
      place_id: 'bad-country', name: 'Unknown', lat: 35, lon: 139,
      timezone: { name: 'Asia/Tokyo' }, country_code: 'jpn',
    } }])).toEqual([])
  })

  test('accepts only Google Maps hostnames for place URL resolution', () => {
    expect(safeGoogleMapsQuery('https://maps.google.com/maps?q=Tokyo+Tower')).toBe('Tokyo Tower')
    expect(() => safeGoogleMapsQuery('https://evil.example/maps?q=Tokyo')).toThrow(/hostname/i)
  })

  test('removes only an explicit Japanese postal prefix from a Google place label', () => {
    expect(cleanGoogleMapsPlaceQuery('日本〒251-0036 神奈川縣藤澤市江之島'))
      .toBe('神奈川縣藤澤市江之島')
    expect(cleanGoogleMapsPlaceQuery('〒251-0036 神奈川県藤沢市江の島'))
      .toBe('神奈川県藤沢市江の島')
    expect(cleanGoogleMapsPlaceQuery('大阪市立美術館')).toBe('大阪市立美術館')
    expect(cleanGoogleMapsPlaceQuery('新宿区役所')).toBe('新宿区役所')
    expect(cleanGoogleMapsPlaceQuery('日本橋')).toBe('日本橋')
  })

  test('resolves an allowlisted Google Maps short URL without following an unsafe redirect', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://maps.app.goo.gl/Enoshima123') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://www.google.com/maps/place/Enoshima' },
        })
      }
      throw new Error(`unexpected request: ${String(input)}`)
    })

    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/Enoshima123', fetchImpl))
      .resolves.toEqual({ query: 'Enoshima' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('prefers exact Google place coordinates over the postal-address path and ignores the map camera center', async () => {
    const finalUrl = 'https://www.google.com/maps/place/%E6%97%A5%E6%9C%AC%E3%80%92251-0036+%E7%A5%9E%E5%A5%88%E5%B7%9D%E7%B8%A3%E8%97%A4%E6%BE%A4%E5%B8%82%E6%B1%9F%E4%B9%8B%E5%B3%B6/@35.3011552,139.4758436,16z/data=!4m6!3m5!1sabc!8m2!3d35.2990992!4d139.4809269'
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: finalUrl },
    }))

    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/KnAS2vAHNjs9A2s77', fetchImpl))
      .resolves.toEqual({
        query: '日本〒251-0036 神奈川縣藤澤市江之島',
        coordinates: { lat: 35.2990992, lng: 139.4809269 },
      })
  })

  test('reads a bounded Google train-station type hint without trusting it as place data', async () => {
    const finalUrl = 'https://www.google.com/maps/place/%E9%90%AE%E5%80%89/@35.3190125,139.5506805,17z/data=!3d35.3190125!4d139.5506805!15sChBLYW1ha3VyYSBTdGF0aW9ukgENdHJhaW5fc3RhdGlvbuABAA'
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: finalUrl },
    }))

    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/wZmGdZBucjCH824z7', fetchImpl))
      .resolves.toEqual({
        query: '鐮倉',
        coordinates: { lat: 35.3190125, lng: 139.5506805 },
        placeTypeHint: 'train_station',
      })
  })

  test('accepts the standard-base64 alphabet in a bounded Google place type hint', async () => {
    const url = 'https://www.google.com/maps/place/%E9%8E%8C%E5%80%89/data=!3d35.3190125!4d139.5506805!15s/3RyYWluX3N0YXRpb24='

    await expect(resolveGoogleMapsUrl(url)).resolves.toMatchObject({
      placeTypeHint: 'train_station',
    })
  })

  test.each([
    ['malformed', '%E0%A4%A'],
    ['unknown', 'Y2FmZQ'],
    ['oversized', 'A'.repeat(1_025)],
  ])('ignores a %s Google place type payload', async (_case, payload) => {
    const url = `https://www.google.com/maps/place/%E9%8E%8C%E5%80%89/data=!3d35.3190125!4d139.5506805!15s${payload}`

    await expect(resolveGoogleMapsUrl(url)).resolves.toEqual({
      query: '鎌倉',
      coordinates: { lat: 35.3190125, lng: 139.5506805 },
    })
  })

  test('does not treat a Google Maps camera center as an exact place coordinate', async () => {
    await expect(resolveGoogleMapsUrl('https://www.google.com/maps/place/Enoshima/@35.3011552,139.4758436,16z'))
      .resolves.toEqual({ query: 'Enoshima' })
  })

  test('treats an explicit coordinate query as coordinates without inventing a place label', async () => {
    await expect(resolveGoogleMapsUrl('https://www.google.com/maps?q=35.2990992,139.4809269'))
      .resolves.toEqual({ coordinates: { lat: 35.2990992, lng: 139.4809269 } })
  })

  test('rejects a Google Maps short URL that redirects outside the allowlist', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://evil.example/steal' },
    }))

    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/Enoshima123', fetchImpl))
      .rejects.toMatchObject({ status: 400 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('provider fetch observes the preview cancellation signal', async () => {
    const controller = new AbortController()
    const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const request = orsMatrix(points, { ORS_API_KEY: 'test-key' }, fetchImpl, controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ status: 504 })
  })

  test('allows ORS Directions twelve seconds and classifies its abort as a timeout', async () => {
    vi.useFakeTimers()
    try {
      let providerSignal: AbortSignal | undefined
      const request = orsDirections(
        points,
        { ORS_API_KEY: 'test-key' },
        (_input, init) => {
          providerSignal = init?.signal ?? undefined
          return new Promise<Response>((_resolve, reject) => {
            providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true })
          })
        },
      )
      const outcome = request.catch(error => error as { status?: number })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(providerSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(4_000)

      await expect(outcome).resolves.toMatchObject({ status: 504 })
    } finally {
      vi.useRealTimers()
    }
  })
})
