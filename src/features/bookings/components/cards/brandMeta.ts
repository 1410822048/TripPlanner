// src/features/bookings/components/cards/brandMeta.ts
// Local brand-color database used by Flight / Hotel / Train cards to give
// each booking a glance-distinctive ticket-style chip — without bundling
// real airline / hotel logos (would balloon the bundle by 100-300 KB and
// add a third-party CDN dependency for offline PWA usage).
//
// Match strategy: caller passes the raw `booking.provider` string. We
// case-insensitive-substring-match against each entry's aliases. First
// hit wins. No match → caller falls back to a neutral palette so the
// card still looks like a ticket, just without brand identity.
//
// Adding more entries: append to the relevant array. Aliases should
// cover (a) the IATA / standard short code, (b) the English name, and
// (c) the local-language name when commonly used in the region.

export interface Brand {
  /** Short label rendered as the "logo" chip (e.g. ANA, JAL). */
  label: string
  /** Full readable name, used for tooltips / accessibility. */
  name:  string
  /** Primary brand color — backgrounds the logo chip / hero band. */
  bg:    string
  /** Foreground that contrasts on `bg`. */
  fg:    string
  /** Lower-cased substrings to match against `provider`. */
  aliases: string[]
}

/** Neutral palette used when the booking's `provider` doesn't match any
 *  catalogued alias — keeps the card readable as a ticket / reservation
 *  rather than rendering a blank band. Each fallback has empty aliases
 *  so it can never match (we return them only via `?? FALLBACKS.x`). */
const FALLBACKS = {
  airline: { label: '✈', name: 'Airline', bg: '#1F3D7A', fg: '#fff', aliases: [] },
  hotel:   { label: '🏨', name: 'Hotel',   bg: '#7B5E3C', fg: '#fff', aliases: [] },
  rail:    { label: '🚆', name: 'Rail',    bg: '#2C5F4D', fg: '#fff', aliases: [] },
} as const satisfies Record<string, Brand>

const AIRLINES: Brand[] = [
  { label: 'ANA',  name: 'ANA',                   bg: '#13448F', fg: '#fff', aliases: ['ana', 'all nippon', '全日空', '全日本空輸'] },
  { label: 'JAL',  name: 'Japan Airlines',        bg: '#C8102E', fg: '#fff', aliases: ['jal', 'japan air', '日本航空', '日航'] },
  { label: 'CI',   name: 'China Airlines',        bg: '#0F4C81', fg: '#fff', aliases: ['ci', 'china airlines', '中華航空', '華航'] },
  { label: 'BR',   name: 'EVA Air',               bg: '#225F4D', fg: '#fff', aliases: ['br', 'eva', '長榮航空', '長榮'] },
  { label: 'CX',   name: 'Cathay Pacific',        bg: '#006564', fg: '#fff', aliases: ['cx', 'cathay', '國泰', '国泰'] },
  { label: 'KE',   name: 'Korean Air',            bg: '#00256C', fg: '#fff', aliases: ['ke', 'korean air', '大韓航空'] },
  { label: 'OZ',   name: 'Asiana Airlines',       bg: '#D71920', fg: '#fff', aliases: ['oz', 'asiana', '韓亞', '韩亚'] },
  { label: 'SQ',   name: 'Singapore Airlines',    bg: '#F99F1B', fg: '#000', aliases: ['sq', 'singapore air', 'sia'] },
  { label: 'TG',   name: 'Thai Airways',          bg: '#5B0F8B', fg: '#fff', aliases: ['tg', 'thai airways', '泰國航空'] },
  { label: 'AA',   name: 'American Airlines',     bg: '#0078D2', fg: '#fff', aliases: ['aa', 'american airlines'] },
  { label: 'UA',   name: 'United Airlines',       bg: '#002244', fg: '#fff', aliases: ['ua', 'united airlines', 'united'] },
  { label: 'DL',   name: 'Delta',                 bg: '#9B1B30', fg: '#fff', aliases: ['dl', 'delta'] },
  { label: 'LH',   name: 'Lufthansa',             bg: '#05164D', fg: '#fff', aliases: ['lh', 'lufthansa'] },
  { label: 'AF',   name: 'Air France',            bg: '#00266F', fg: '#fff', aliases: ['af', 'air france'] },
  { label: 'BA',   name: 'British Airways',       bg: '#075AAA', fg: '#fff', aliases: ['ba', 'british airways'] },
  { label: 'QF',   name: 'Qantas',                bg: '#E40000', fg: '#fff', aliases: ['qf', 'qantas'] },
  { label: 'NZ',   name: 'Air New Zealand',       bg: '#000', fg: '#fff', aliases: ['nz', 'air new zealand'] },
  { label: 'PR',   name: 'Philippine Airlines',   bg: '#1B3F73', fg: '#fff', aliases: ['pr', 'philippine airlines'] },
  { label: 'VN',   name: 'Vietnam Airlines',      bg: '#005AAA', fg: '#fff', aliases: ['vn', 'vietnam airlines'] },
  { label: 'TR',   name: 'Scoot',                 bg: '#FFCD00', fg: '#000', aliases: ['tr', 'scoot'] },
  { label: '3K',   name: 'Jetstar',               bg: '#FF5115', fg: '#fff', aliases: ['3k', 'jetstar', 'jq'] },
  { label: 'TW',   name: "T'way Air",             bg: '#0072BC', fg: '#fff', aliases: ['tw', "t'way", 'tway'] },
  { label: 'IT',   name: 'Tigerair',              bg: '#F5821F', fg: '#fff', aliases: ['it', 'tigerair', '虎航'] },
  { label: 'JX',   name: 'Starlux',               bg: '#0D2C54', fg: '#fff', aliases: ['jx', 'starlux', '星宇航空', '星宇'] },
  { label: 'B7',   name: 'Uni Air',               bg: '#0D9748', fg: '#fff', aliases: ['b7', 'uni air', '立榮'] },
  { label: 'AE',   name: 'Mandarin Airlines',     bg: '#F4A300', fg: '#000', aliases: ['ae', 'mandarin airlines', '華信'] },
  { label: 'GE',   name: 'Tigerair Taiwan',       bg: '#F5821F', fg: '#fff', aliases: ['ge', 'tigerair taiwan', '台灣虎航'] },
  { label: 'HX',   name: 'Hong Kong Airlines',    bg: '#A2272D', fg: '#fff', aliases: ['hx', 'hong kong airlines', '香港航空'] },
]

const HOTELS: Brand[] = [
  // OTA / short-rental platforms that users typically book through —
  // these come first because the booking.provider field most commonly
  // names the platform (Airbnb / Booking.com), not the underlying chain.
  { label: 'Airbnb',     name: 'Airbnb',           bg: '#FF5A5F', fg: '#fff', aliases: ['airbnb', 'air bnb'] },
  { label: 'Booking',    name: 'Booking.com',      bg: '#003580', fg: '#fff', aliases: ['booking.com', 'booking'] },
  { label: 'Agoda',      name: 'Agoda',            bg: '#5392F9', fg: '#fff', aliases: ['agoda'] },
  { label: 'Expedia',    name: 'Expedia',          bg: '#00355F', fg: '#fff', aliases: ['expedia'] },
  { label: 'Trip',       name: 'Trip.com',         bg: '#287DFC', fg: '#fff', aliases: ['trip.com', 'ctrip', '攜程', '携程'] },
  { label: 'Hotels',     name: 'Hotels.com',       bg: '#D32F2F', fg: '#fff', aliases: ['hotels.com'] },
  { label: '樂天',        name: '楽天トラベル',       bg: '#BF0000', fg: '#fff', aliases: ['rakuten travel', '楽天トラベル', '樂天旅遊'] },
  { label: 'Jalan',      name: 'じゃらん',          bg: '#FF6600', fg: '#fff', aliases: ['jalan', 'じゃらん'] },
  { label: 'VRBO',       name: 'Vrbo',             bg: '#1A2A36', fg: '#fff', aliases: ['vrbo'] },
  // Hotel chains — matched after platforms so a "Marriott via Booking.com"
  // booking surfaces as Booking (the platform that holds the reservation).
  { label: 'Marriott',   name: 'Marriott',         bg: '#A4123F', fg: '#fff', aliases: ['marriott'] },
  { label: 'Hilton',     name: 'Hilton',           bg: '#04153B', fg: '#fff', aliases: ['hilton'] },
  { label: 'Hyatt',      name: 'Hyatt',            bg: '#0E2240', fg: '#fff', aliases: ['hyatt'] },
  { label: 'IHG',        name: 'InterContinental', bg: '#152652', fg: '#fff', aliases: ['intercontinental', 'ihg', 'holiday inn', 'crowne plaza'] },
  { label: 'Accor',      name: 'Accor',            bg: '#1D1D2C', fg: '#fff', aliases: ['accor', 'novotel', 'mercure', 'sofitel', 'ibis'] },
  { label: 'Dormy Inn',  name: 'Dormy Inn',        bg: '#003D6E', fg: '#fff', aliases: ['dormy inn', 'dormyinn', 'ドーミーイン'] },
  { label: 'APA',        name: 'APA Hotel',        bg: '#E60012', fg: '#fff', aliases: ['apa hotel', 'apa ホテル', 'apa'] },
  { label: 'Toyoko',     name: 'Toyoko Inn',       bg: '#2A4A99', fg: '#fff', aliases: ['toyoko inn', 'toyokoinn', '東横イン'] },
  { label: 'Hoshino',    name: 'Hoshino Resorts',  bg: '#2A4D44', fg: '#fff', aliases: ['hoshino', 'hoshinoya', '星野', '星のや'] },
  { label: 'Tokyu',      name: 'Tokyu Stay',       bg: '#E50012', fg: '#fff', aliases: ['tokyu stay', '東急ステイ'] },
  { label: 'Prince',     name: 'Prince Hotels',    bg: '#1E3A5F', fg: '#fff', aliases: ['prince hotel', 'プリンスホテル'] },
]

const RAIL_OPERATORS: Brand[] = [
  { label: 'JR East',  name: 'JR East',  bg: '#008559', fg: '#fff', aliases: ['jr east', 'jr 東日本', 'jr東日本'] },
  { label: 'JR West',  name: 'JR West',  bg: '#0072BC', fg: '#fff', aliases: ['jr west', 'jr 西日本', 'jr西日本'] },
  { label: 'JR Tokai', name: 'JR Tokai', bg: '#F77F00', fg: '#fff', aliases: ['jr tokai', 'jr central', 'jr 東海', 'jr東海'] },
  { label: 'JR Kyushu',name: 'JR Kyushu',bg: '#E60012', fg: '#fff', aliases: ['jr kyushu', 'jr 九州', 'jr九州'] },
  { label: 'JR',       name: 'JR Group', bg: '#0E7C49', fg: '#fff', aliases: ['jr', 'japan rail', 'japan railways'] },
  { label: 'Keikyu',   name: 'Keikyu',   bg: '#E60012', fg: '#fff', aliases: ['keikyu', '京急'] },
  { label: 'Keisei',   name: 'Keisei',   bg: '#005BAC', fg: '#fff', aliases: ['keisei', '京成'] },
  { label: 'TRA',      name: 'Taiwan Rail', bg: '#0E2A56', fg: '#fff', aliases: ['tra', 'taiwan rail', '台鐵', '臺鐵'] },
  { label: 'THSR',     name: 'Taiwan HSR', bg: '#F36F21', fg: '#fff', aliases: ['thsr', 'taiwan high speed', '高鐵', '台灣高鐵'] },
  { label: 'KTX',      name: 'KTX',      bg: '#003478', fg: '#fff', aliases: ['ktx', 'korail', '韓國高鐵'] },
  { label: 'Eurostar', name: 'Eurostar', bg: '#FFD800', fg: '#000', aliases: ['eurostar'] },
]

function matchBrand(provider: string | undefined, table: Brand[]): Brand | null {
  if (!provider) return null
  const needle = provider.toLowerCase().trim()
  if (!needle) return null
  for (const b of table) {
    for (const a of b.aliases) {
      if (needle.includes(a)) return b
    }
  }
  return null
}

export function airlineBrand(provider: string | undefined): Brand {
  return matchBrand(provider, AIRLINES) ?? FALLBACKS.airline
}

export function hotelBrand(provider: string | undefined): Brand {
  return matchBrand(provider, HOTELS) ?? FALLBACKS.hotel
}

export function railBrand(provider: string | undefined): Brand {
  return matchBrand(provider, RAIL_OPERATORS) ?? FALLBACKS.rail
}
