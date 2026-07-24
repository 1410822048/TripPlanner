import { describe, expect, test, vi } from 'vitest'
import {
  buildDisplayGeometry,
  findTimeConflictIds,
  resolveRoutePlace,
  routeScheduleFingerprint,
  routeValidationErrorCatcher,
  RouteValidationError,
  scheduleFromDoc,
  type RoutePreviewLeg,
  type RouteSchedule,
} from '../src/route-preview'

const place = (id: string, lat: number, lng: number) => ({
  provider: 'geoapify' as const,
  providerPlaceId: id,
  name: id,
  lat,
  lng,
  timeZone: 'Asia/Tokyo',
  countryCode: 'JP',
})

function schedule(id: string, order: number, startTime?: string): RouteSchedule {
  return {
    id,
    order,
    timeMode: startTime ? 'preferred' : 'flexible',
    ...(startTime ? { startTime } : {}),
    durationMinutes: 60,
    location: place(id, 35 + order * 0.01, 139 + order * 0.01),
  }
}

describe('route schedule fingerprint', () => {
  test('is independent of Firestore result order when schedule orders tie', async () => {
    const upper = schedule('A', 0)
    const lower = schedule('a', 0)

    await expect(routeScheduleFingerprint([upper, lower])).resolves.toBe(
      await routeScheduleFingerprint([lower, upper]),
    )
  })
})

describe('route preview display contract', () => {
  test.each([
    {
      label: '江之島海蠟燭展望燈塔',
      shortUrl: 'https://maps.app.goo.gl/SN33R6j3n6kpSAk7A',
      exact: { lat: 35.2997417, lng: 139.478425 },
      nearby: [
        { place_id: '21-days', name: '21 days', lat: 35.29973, lon: 139.47844 },
        { place_id: 'todai-kitchen', name: 'Todai Kitchen', lat: 35.29958, lon: 139.47855 },
      ],
    },
    {
      label: '澀谷 SKY',
      shortUrl: 'https://maps.app.goo.gl/SBgQ6WqpuHFxbnZn6',
      exact: { lat: 35.6586719, lng: 139.7019848 },
      nearby: [
        { place_id: 'shibuya-sky-osm', name: '渋谷スカイ', lat: 35.65823, lon: 139.70208 },
      ],
    },
    {
      label: 'Maison Paul Bocuse',
      shortUrl: 'https://maps.app.goo.gl/sW7qenADJYqTugFHA',
      exact: { lat: 35.649535, lng: 139.6987557 },
      nearby: [
        { place_id: 'aloha-table', name: 'アロハテーブル', lat: 35.64955, lon: 139.69877 },
      ],
    },
  ])('keeps the authoritative Google identity and pin for $label', async ({ label, shortUrl, exact, nearby }) => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === shortUrl) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://www.google.com/maps/place/${encodeURIComponent(label)}/data=!3d${exact.lat}!4d${exact.lng}`,
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({
          features: nearby.map(place => ({ properties: {
            ...place,
            result_type: 'amenity',
            formatted: `${place.name}, 日本`,
            timezone: { name: 'Asia/Tokyo' },
            country_code: 'jp',
          } })),
        }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: shortUrl,
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toEqual([expect.objectContaining({
        provider: 'google-maps',
        name: label,
        ...exact,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      })])
      expect(result.candidates[0]).not.toHaveProperty('address')
      expect(requests.filter(url => url.includes('geoapify.com'))).toHaveLength(1)
      expect(requests.some(url => url.includes('/v1/geocode/search'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('reads a persisted google-maps PlaceRef without changing its provider', () => {
    const parsed = scheduleFromDoc({
      exists: true,
      name: 'projects/test/databases/(default)/documents/trips/trip-1/schedules/google-place',
      updateTime: '2026-07-20T00:00:00.000Z',
      fields: {
        order: { integerValue: '0' },
        timeMode: { stringValue: 'flexible' },
        durationMinutes: { integerValue: '60' },
        location: { mapValue: { fields: {
          status: { stringValue: 'resolved' },
          place: { mapValue: { fields: {
            provider: { stringValue: 'google-maps' },
            providerPlaceId: { stringValue: 'google-id' },
            name: { stringValue: '澀谷 SKY' },
            lat: { doubleValue: 35.6586719 },
            lng: { doubleValue: 139.7019848 },
            timeZone: { stringValue: 'Asia/Tokyo' },
            countryCode: { stringValue: 'JP' },
          } } },
        } } },
      },
    })

    expect(parsed?.location.provider).toBe('google-maps')
  })

  test('keeps 鎌倉駅 when the Google link carries an explicit station hint', async () => {
    const requests: string[] = []
    const exact = { lat: 35.3190125, lng: 139.5506805 }
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://maps.app.goo.gl/wZmGdZBucjCH824z7') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://www.google.com/maps/place/%E9%90%AE%E5%80%89/data=!3d${exact.lat}!4d${exact.lng}!15sChBLYW1ha3VyYSBTdGF0aW9ukgENdHJhaW5fc3RhdGlvbuABAA`,
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [{ properties: {
          place_id: 'kamakura-station',
          name: '鎌倉駅',
          address_line1: '鎌倉駅',
          result_type: 'amenity',
          formatted: '鎌倉駅, 鎌倉市, 日本',
          lat: exact.lat,
          lon: exact.lng,
          timezone: { name: 'Asia/Tokyo' },
          country_code: 'jp',
        } }] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/wZmGdZBucjCH824z7',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      const providerRequests = requests.filter(url => url.startsWith('https://api.geoapify.com/'))
      expect(providerRequests).toHaveLength(1)
      expect(result.candidates[0]).toMatchObject({ provider: 'google-maps', name: '鎌倉駅', ...exact })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('does not apply a Japanese station suffix outside an explicit JP context', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://maps.app.goo.gl/non-jp-station') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: 'https://www.google.com/maps/place/%E9%8E%8C%E5%80%89/data=!3d35.3190125!4d139.5506805!15sChBLYW1ha3VyYSBTdGF0aW9ukgENdHJhaW5fc3RhdGlvbuABAA',
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [{ properties: {
          place_id: 'taiwan-pin', name: '鎌倉', lat: 25, lon: 121,
          timezone: { name: 'Asia/Taipei' }, country_code: 'tw',
        } }] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/non-jp-station',
        bias: { countryCode: 'TW', normalizationCountryCode: 'TW' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates[0]).toMatchObject({ name: '鎌倉', countryCode: 'TW' })
      expect(requests.some(url => url.includes('/v1/geocode/search'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('keeps a conservatively cleaned Google address label at its exact pin', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://maps.app.goo.gl/KnAS2vAHNjs9A2s77') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: 'https://www.google.com/maps/place/%E6%97%A5%E6%9C%AC%E3%80%92251-0036+%E7%A5%9E%E5%A5%88%E5%B7%9D%E7%B8%A3%E8%97%A4%E6%BE%A4%E5%B8%82%E6%B1%9F%E4%B9%8B%E5%B3%B6/@35.3011552,139.4758436,16z/data=!3d35.2990992!4d139.4809269',
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [{ properties: {
          place_id: 'enoshima',
          name: '藤沢市',
          suburb: '江の島',
          city: '藤沢市',
          result_type: 'suburb',
          formatted: '江の島, 藤沢市, 神奈川県, 日本',
          lat: 35.2990992,
          lon: 139.4809269,
          timezone: { name: 'Asia/Tokyo' },
          country_code: 'jp',
        } }] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/KnAS2vAHNjs9A2s77',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates[0]).toMatchObject({
        provider: 'google-maps',
        name: '神奈川縣藤澤市江之島',
        lat: 35.2990992,
        lng: 139.4809269,
      })
      expect(requests).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('keeps 江ノ島駅 only when the nearby station identity matches the Google label', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://maps.app.goo.gl/77eHSXgc8AQgjkbA9') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: 'https://www.google.com/maps/place/%E6%B1%9F%E4%B9%8B%E5%B3%B6/@35.3109262,139.4870548,19.96z/data=!4m6!3m5!1sabc!8m2!3d35.3110477!4d139.4873844',
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [
          { properties: {
            place_id: 'enoshima-local-name',
            name: '江ノ島',
            address_line1: '江ノ島',
            result_type: 'amenity',
            category: 'public_transport.train',
            formatted: '江ノ島, 国道467号, 片瀬海岸, 藤沢市, 日本',
            lat: 35.3110329,
            lon: 139.4875308,
            timezone: { name: 'Asia/Tokyo' },
            country_code: 'jp',
          } },
          { properties: {
            place_id: 'enoshima-station-alias',
            name: 'Enoshima Eki',
            address_line1: 'Enoshima Eki',
            result_type: 'amenity',
            formatted: 'Enoshima Eki, 鎌倉市, 日本',
            lat: 35.31103,
            lon: 139.48763,
            timezone: { name: 'Asia/Tokyo' },
            country_code: 'jp',
          } },
        ] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/77eHSXgc8AQgjkbA9',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0]).toMatchObject({
        provider: 'google-maps',
        name: '江ノ島駅',
        lat: 35.3110477,
        lng: 139.4873844,
      })
      expect(requests).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('does not infer a Japanese station suffix from a cross-script nearby category alone', async () => {
    const exact = { lat: 35.3067242, lng: 139.5005569 }
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://maps.app.goo.gl/6WdzJfp142SGXRuG7') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://www.google.com/maps/place/%E9%8E%8C%E5%80%89%E9%AB%98%E6%A0%A1%E5%89%8D/data=!3d${exact.lat}!4d${exact.lng}`,
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [{ properties: {
          place_id: 'kamakura-kokomae-station',
          name: 'Kamakura Kōkōmae Eki',
          address_line1: 'Kamakura Kōkōmae Eki',
          result_type: 'amenity',
          category: 'public_transport.train',
          formatted: 'Kamakura Kōkōmae Eki, 鎌倉市, 日本',
          lat: exact.lat,
          lon: exact.lng,
          timezone: { name: 'Asia/Tokyo' },
          country_code: 'jp',
        } }] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/6WdzJfp142SGXRuG7',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.query).toBe('鎌倉高校前')
      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0]).toMatchObject({
        provider: 'google-maps',
        name: '鎌倉高校前',
        ...exact,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('keeps an English Google station label while using category only as station evidence', async () => {
    const exact = { lat: 35.3110477, lng: 139.4873844 }
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://maps.app.goo.gl/cross-script-station') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://www.google.com/maps/place/Enoshima+Station/data=!3d${exact.lat}!4d${exact.lng}`,
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [
          { properties: {
            place_id: 'enoshima-station-ja',
            name: '江ノ島駅',
            address_line1: '江ノ島駅',
            result_type: 'amenity',
            category: 'public_transport.train',
            formatted: '江ノ島駅, 藤沢市, 日本',
            lat: exact.lat,
            lon: exact.lng,
            timezone: { name: 'Asia/Tokyo' },
            country_code: 'jp',
          } },
          { properties: {
            place_id: 'unrelated-amenity',
            name: '観光案内所',
            result_type: 'amenity',
            formatted: '観光案内所, 藤沢市, 日本',
            lat: exact.lat + 0.00108,
            lon: exact.lng,
            timezone: { name: 'Asia/Tokyo' },
            country_code: 'jp',
          } },
        ] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/cross-script-station',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toEqual([expect.objectContaining({
        provider: 'google-maps',
        name: 'Enoshima Station',
        ...exact,
      })])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('serializes route validation errors with stable codes', () => {
    expect(routeValidationErrorCatcher(new RouteValidationError(
      403,
      'role',
      'ROUTE_EDITOR_REQUIRED',
      'editor permission is required',
    ))).toMatchObject({
      status: 403,
      body: {
        error: 'editor permission is required',
        code: 'ROUTE_EDITOR_REQUIRED',
        field: 'role',
      },
      precommit: true,
    })
  })

  test('uses reverse geocoding only for metadata and never copies a nearby address identity', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://maps.app.goo.gl/77eHSXgc8AQgjkbA9') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: 'https://www.google.com/maps/place/%E6%B1%9F%E4%B9%8B%E5%B3%B6/data=!3d35.3110477!4d139.4873844',
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [{ properties: {
          place_id: 'nearby-road',
          name: 'すばな通り',
          result_type: 'street',
          formatted: 'すばな通り, 片瀬海岸, 藤沢市, 日本',
          lat: 35.31102,
          lon: 139.4874,
          timezone: { name: 'Asia/Tokyo' },
          country_code: 'jp',
        } }] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/77eHSXgc8AQgjkbA9',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toEqual([expect.objectContaining({
        provider: 'google-maps',
        name: '江之島',
        lat: 35.3110477,
        lng: 139.4873844,
      })])
      expect(result.candidates[0]).not.toHaveProperty('address')
      expect(requests.map(url => url.includes('/v1/geocode/reverse') ? 'reverse' : 'redirect'))
        .toEqual(['redirect', 'reverse'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('does not turn a Google POI into a station merely because a rail feature is nearby', async () => {
    const exact = { lat: 35.6812, lng: 139.7671 }
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://maps.app.goo.gl/station-coffee') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://www.google.com/maps/place/%E3%82%B9%E3%82%BF%E3%83%BC%E3%83%90%E3%83%83%E3%82%AF%E3%82%B9/data=!3d${exact.lat}!4d${exact.lng}`,
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [{ properties: {
          place_id: 'nearby-station',
          name: '東京駅',
          category: 'public_transport.train',
          lat: exact.lat,
          lon: exact.lng,
          timezone: { name: 'Asia/Tokyo' },
          country_code: 'jp',
        } }] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/station-coffee',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toEqual([expect.objectContaining({
        provider: 'google-maps',
        name: 'スターバックス',
        ...exact,
      })])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('returns empty when reverse metadata has no valid country or time zone', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://maps.app.goo.gl/KnAS2vAHNjs9A2s77') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: 'https://www.google.com/maps/place/%E6%97%A5%E6%9C%AC%E3%80%92251-0036+%E7%A5%9E%E5%A5%88%E5%B7%9D%E7%B8%A3%E8%97%A4%E6%BE%A4%E5%B8%82%E6%B1%9F%E4%B9%8B%E5%B3%B6/data=!3d35.2990992!4d139.4809269',
          },
        })
      }
      if (url.startsWith('https://api.geoapify.com/v1/geocode/reverse?')) {
        return new Response(JSON.stringify({ features: [{ properties: {
          place_id: 'nearby',
          name: '江の島',
          formatted: '江の島, 藤沢市, 日本',
          lat: 35.2990992,
          lon: 139.4809269,
        } }] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://maps.app.goo.gl/KnAS2vAHNjs9A2s77',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toEqual([])
      expect(requests.map(url => url.includes('/v1/geocode/reverse') ? 'reverse' : 'redirect'))
        .toEqual(['redirect', 'reverse'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('returns empty for a Google Maps place link without an exact place pin', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      throw new Error(`unexpected request: ${url}`)
    })

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://www.google.com/maps/place/Enoshima/@35.3011552,139.4758436,16z',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toEqual([])
      expect(requests).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('returns empty for a coordinate-only Google Maps link without a place label', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await resolveRoutePlace({
        tripId: 'trip-1',
        googleMapsUrl: 'https://www.google.com/maps?q=35.2990992,139.4809269',
        bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
      }, { GEOAPIFY_API_KEY: 'test-key' })

      expect(result.candidates).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('marks both schedules around a preferred-time inversion', () => {
    expect(findTimeConflictIds([
      schedule('b', 0, '14:00'),
      schedule('c', 1),
      schedule('a', 2, '10:00'),
    ])).toEqual(['b', 'a'])
  })

  test('draws ORS only for short walking legs and a direct reference line for long legs', () => {
    const schedules = [schedule('a', 0), schedule('b', 1), schedule('c', 2)]
    const legs: RoutePreviewLeg[] = [
      { legIndex: 0, fromId: 'a', toId: 'b', kind: 'walking', walkingMinutes: 10, geometryAvailable: true },
      {
        legIndex: 1,
        fromId: 'b',
        toId: 'c',
        kind: 'transit-check',
        walkingMinutes: 30,
        geometryAvailable: false,
        transitEstimate: { minMinutes: 20, maxMinutes: 30, basis: 'ors-walking-distance' },
      },
    ]
    const geometry = buildDisplayGeometry(schedules, legs, {
      durationMinutes: 40,
      distanceMeters: 4000,
      coordinates: [[139, 35], [139.02, 35.02]],
      legs: [
        { durationMinutes: 10, distanceMeters: 500, coordinates: [[139, 35], [139.01, 35.01]] },
        { durationMinutes: 30, distanceMeters: 3500, coordinates: [[139.01, 35.01], [139.02, 35.02]] },
      ],
    })

    expect(geometry.features[0]).toMatchObject({
      properties: { provider: 'ors', mode: 'walking' },
    })
    expect(geometry.features[1]).toEqual({
      type: 'Feature',
      properties: { provider: 'reference', mode: 'transit-check', legIndex: 1 },
      geometry: {
        type: 'LineString',
        coordinates: [[139.01, 35.01], [139.02, 35.02]],
      },
    })
  })
})
