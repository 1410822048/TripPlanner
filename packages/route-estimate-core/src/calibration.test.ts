// Calibration fixture for the door-to-door transit estimate (2026-10-13).
//
// `ride` is the in-vehicle time quoted by the cited source. Door-to-door
// adds what a traveller actually spends: walking to and inside the station,
// the average wait (about half the headway), any transfer, and the walk out
// to the destination. Those additions are stated per route and are
// assumptions, not measurements — re-check against Google Maps door-to-door
// times (weekday midday) when tuning the constants again.
//
// The walking-network distance is approximated the same way the timeline
// does before a route is applied: straight line × 1.25.
import { describe, expect, test } from 'vitest'
import { estimateTransitRange, straightLineMeters, type Coordinate } from './index'

interface ReferenceRoute {
  name: string
  from: Coordinate
  to: Coordinate
  ride: string
  doorToDoor: [number, number]
  /** Why the central estimate may legitimately be more than 30% off. */
  knownLimit?: string
}

const REFERENCE_ROUTES: ReferenceRoute[] = [
  {
    name: '澀谷十字路口 → 明治神宮',
    from: { lat: 35.6595, lng: 139.7005 }, to: { lat: 35.6702, lng: 139.6993 },
    ride: 'JR 山手線 澀谷→原宿 約 3 分（mileasia.com）；+ 進站 4、候車 2、出站到鳥居 3',
    doorToDoor: [10, 15],
  },
  {
    name: '淺草寺 → 東京晴空塔',
    from: { lat: 35.7148, lng: 139.7967 }, to: { lat: 35.7101, lng: 139.8107 },
    ride: '東武晴空塔線 約 2 分，含步行約 10 分（rome2rio.com）；步行 1.7 km 約 20 分',
    doorToDoor: [10, 15],
  },
  {
    name: '京都車站 → 伏見稻荷大社',
    from: { lat: 34.9858, lng: 135.7588 }, to: { lat: 34.9671, lng: 135.7727 },
    ride: 'JR 奈良線 京都→稻荷 約 5 分（kyotostation.com）；+ 站內 3、普通車候車 5、出站 1',
    doorToDoor: [12, 20],
  },
  {
    name: '新宿站 → 澀谷站',
    from: { lat: 35.6896, lng: 139.7006 }, to: { lat: 35.6580, lng: 139.7016 },
    ride: 'JR 山手線 約 6–7 分（mileasia.com）；+ 站內 3、候車 2、出站 2',
    doorToDoor: [13, 18],
    knownLimit: '兩端都是車站：固定的進出站時間在車站對車站時偏多',
  },
  {
    name: '東京車站 → 淺草寺',
    from: { lat: 35.6812, lng: 139.7671 }, to: { lat: 35.7148, lng: 139.7967 },
    ride: 'JR 到神田 + 銀座線 約 16 分（mileasia.com）；+ 站內 4、轉乘候車 3、出站到寺 5',
    doorToDoor: [25, 30],
  },
  {
    name: '難波 → 環球影城',
    from: { lat: 34.6662, lng: 135.5005 }, to: { lat: 34.6654, lng: 135.4323 },
    ride: '阪神難波線 + JR 夢咲線 約 20–30 分，西九条轉乘（mileasia.com、jw-webmagazine.com）；+ 進出站 5',
    doorToDoor: [30, 35],
  },
  {
    name: '澀谷 → 台場',
    from: { lat: 35.6580, lng: 139.7016 }, to: { lat: 35.6272, lng: 139.7766 },
    ride: 'JR 埼京線直通臨海線 約 20–24 分（jw-webmagazine.com、trip.com）；+ 進站候車 5、出站 5',
    doorToDoor: [30, 35],
  },
  {
    name: '新宿站 → 淺草寺',
    from: { lat: 35.6896, lng: 139.7006 }, to: { lat: 35.7148, lng: 139.7967 },
    ride: 'JR 中央線到神田 + 銀座線 約 29 分（mileasia.com）；+ 站內 3、候車 3、出站到寺 5',
    doorToDoor: [35, 45],
  },
  {
    name: '京都車站 → 金閣寺（市巴士）',
    from: { lat: 34.9858, lng: 135.7588 }, to: { lat: 35.0394, lng: 135.7292 },
    ride: '市巴士 205 系統 約 45 分（kyoto.travel）；地下鐵 + 公車約 35–40 分；+ 候車、下車步行',
    doorToDoor: [40, 60],
    knownLimit: '京都市區公車：停站多又塞車，比同距離的鐵路慢得多',
  },
  {
    name: '東京車站 → 橫濱港未來',
    from: { lat: 35.6812, lng: 139.7671 }, to: { lat: 35.4576, lng: 139.6328 },
    ride: 'JR 東海道線到橫濱 + 港未來線 約 30 分（cedec.cesa.or.jp）；+ 轉乘候車 5、進出站 5',
    doorToDoor: [40, 45],
  },
  {
    name: '京都車站 → 大阪站（梅田）',
    from: { lat: 34.9858, lng: 135.7588 }, to: { lat: 34.7025, lng: 135.4959 },
    ride: 'JR 新快速 約 24–29 分（expatolife.com）；+ 候車 5、進出站 6',
    doorToDoor: [35, 45],
    knownLimit: 'JR 新快速是最快的通勤列車之一，快於模型假設的快速列車速度',
  },
  {
    name: '東京車站 → 鎌倉站',
    from: { lat: 35.6812, lng: 139.7671 }, to: { lat: 35.3190, lng: 139.5507 },
    ride: 'JR 橫須賀線 約 1 小時、10–15 分一班（gltjp.com、japan-experience.com）；+ 候車 6、進出站 5',
    doorToDoor: [65, 75],
  },
  {
    name: '成田機場 → 淺草寺',
    from: { lat: 35.7720, lng: 140.3929 }, to: { lat: 35.7148, lng: 139.7967 },
    ride: 'Access 特急 約 50–58 分（tobu.co.jp、livejapan.com）；+ 航廈到月台 10、候車 8、出站到寺 5',
    doorToDoor: [75, 90],
  },
]

const WALKING_ROUTE_FACTOR = 1.25

function central({ minMinutes, maxMinutes }: { minMinutes: number; maxMinutes: number }): number {
  return (minMinutes + maxMinutes) / 2
}

describe('transit estimate calibration', () => {
  test.each(REFERENCE_ROUTES)('$name: the range reaches the reference door-to-door time', route => {
    const walkingMeters = straightLineMeters(route.from, route.to) * WALKING_ROUTE_FACTOR
    const range = estimateTransitRange(walkingMeters)
    const [low, high] = route.doorToDoor
    expect(range.minMinutes).toBeLessThanOrEqual(high)
    expect(range.maxMinutes).toBeGreaterThanOrEqual(low)
  })

  test.each(REFERENCE_ROUTES.filter(route => !route.knownLimit))(
    '$name: the range centre is within 30% of the reference',
    route => {
      const walkingMeters = straightLineMeters(route.from, route.to) * WALKING_ROUTE_FACTOR
      const reference = (route.doorToDoor[0] + route.doorToDoor[1]) / 2
      const error = Math.abs(central(estimateTransitRange(walkingMeters)) - reference) / reference
      expect(error).toBeLessThanOrEqual(0.3)
    },
  )

  test('known limits stay few and documented', () => {
    const limits = REFERENCE_ROUTES.filter(route => route.knownLimit)
    expect(limits.length).toBeLessThanOrEqual(3)
    for (const route of limits) expect(route.knownLimit!.length).toBeGreaterThan(10)
  })
})
