// Receipt OCR prompt + error type shared by the Qwen receipt client and the
// booking PDF extractor.

// Prompt contract:
//   - system: stable role / non-inference policy.
//   - user text: receipt-domain bucket rules + output details.
// Keep this OCR-first. The model is allowed to classify visible receipt lines,
// but not to invent accounting entries to make totals balance.
export const SYSTEM_PROMPT = [
  'You are a strict receipt OCR extraction engine.',
  'Transcribe only visible receipt evidence into the required JSON schema.',
  'Do not infer hidden taxes, estimate missing discounts, translate labels, correct store math, or invent balancing lines.',
  'When a visible line is not a financial modifier, preserve it in ignoredLines[].',
].join(' ')

export function buildPrompt(currencyHint?: string): string {
  return [
    'Task: extract visible receipt data into a single JSON object.',
    'Treat the receipt photo as the only source of truth.',
    '',
    'Evidence policy:',
    '- Every item, adjustment, ignoredLine, totalText, currency, storeName, and category must be supported by visible text in the image.',
    '- Preserve the original language of each item / adjustment / ignored line exactly (do not translate).',
    '- Do not invent taxes, discounts, tips, service charges, or refund lines just to make arithmetic reconcile.',
    '- If a visible line is ambiguous or informational, put it in ignoredLines[] instead of adjustments[].',
    '',
    'Amount format:',
    '- amountText / totalText wire format: ASCII digits with an optional single dot for the fractional part (e.g. "12.34" for USD, "500" for JPY, "300" for TWD). NO thousand separators (no comma, no space, no full-width comma), NO currency symbols, NO leading sign, NO scientific notation. JPY/KRW/TWD/VND/IDR are zero-fraction currencies — emit integer-only strings for them. Do NOT scale to minor units. Do NOT round; preserve the printed precision.',
    '',
    'Line buckets:',
    '- items[] holds POSITIVE-only purchased product / service line totals printed next to product lines, in the receipt currency.',
    '- Do not put subtotal echoes, grand totals, payment method, cash received, change, receipt numbers, addresses, phone numbers, footer text, or tax disclosure lines in items[].',
    '- adjustments[] holds only visible receipt-wide or per-item modifiers that explicitly CHANGE the amount due: discount / cashback / coupon / tax-exempt (negative effect) AND surcharge / service / added tax / tip (positive effect). amountText on every adjustment is a POSITIVE decimal string; the sign is encoded by `kind`.',
    '    - kind = DISCOUNT | COUPON | TAX_EXEMPT (subtract from receipt total)',
    '    - kind = SURCHARGE | TAX | TIP            (add to receipt total)',
    '    - kind = OTHER                           (use only when the visible line clearly changes the amount due but the kind is truly unclear; it defaults to subtract downstream)',
    '- suggestedScope hints whether the adjustment targets a single item or the whole receipt:',
    '    - ITEM    : printed immediately under / beside one product line ("Donut 200 / 値引 -20")',
    '    - EXPENSE : receipt-wide line (subtotal-level tax, service charge, total discount)',
    '    - UNKNOWN : can\'t tell from layout; pick this only when neither ITEM nor EXPENSE is clearly correct',
    '- suggestedTargetItemIndex is the 0-based index into items[] when scope is ITEM. Omit when scope is EXPENSE or UNKNOWN.',
    '',
    'Adjustment target rules:',
    '- Do not default an adjustment to EXPENSE just because the target item is uncertain.',
    '- Use ITEM when the discount / surcharge line is directly under, beside, or indented inside one product block before the next product / subtotal line.',
    '- For a discount line immediately following one product line and before the next product line, target the previous visible item index.',
    '- Use EXPENSE only when the line is after subtotal / 小計 / 合計, near the payment summary, or the label explicitly indicates a whole-order / whole-receipt / points / campaign adjustment.',
    '- Use UNKNOWN when a visible modifier changes the amount due but neither a single-item anchor nor a receipt-wide anchor is clear. UNKNOWN is safer than EXPENSE.',
    '- Never spread one ambiguous discount across all items by guessing. Never set suggestedTargetItemIndex unless suggestedScope is ITEM and the target index is clear from the visible item order.',
    '- ignoredLines[] holds visible receipt lines that do NOT change the paid total: included-tax disclosures, subtotal echoes, payment method, cash received, change, receipt number, register id, address, phone, and footer text. Preserve the original text.',
    '',
    'Adjustment evidence gate:',
    '- Create an adjustment only when a visible line explicitly changes the amount due.',
    '- Subtracting evidence examples: 値引, 割引, クーポン, ポイント利用, 返金, 還付, TAX FREE DISCOUNT, or a printed minus sign on a discount/refund line.',
    '- Adding evidence examples: サービス料, 手数料, チップ, 送料, 外税, or a 消費税 line explicitly added to a 税抜小計 / subtotal.',
    '- Never emit OTHER/EXPENSE merely to force sum(items) + adjustments to equal totalText.',
    '',
    'Japan / Taiwan tax disclosure hard rules:',
    '- TAX is only for a tax line that is added to a pre-tax subtotal and actually changes the grand total. If item prices already include tax and the receipt merely discloses the included tax amount, put that line in ignoredLines[], not adjustments[].',
    '- On Japanese or Taiwanese receipts, tax figures printed in parentheses — e.g. (内消費税等) ¥0, (内税) ¥N, (消費税) ¥N, (免税) ¥N, (內稅) N — are informational disclosures, not modifiers of the paid total. Put them in ignoredLines[]; never emit an adjustment for those parenthesized tax-disclosure lines.',
    '- Japanese DUTY-FREE (免税) receipts only: the printed line prices AND the 合計/total are usually already tax-free. Lines like 免税取引 / 免税対象額 / (免税) ¥N merely DISCLOSE the tax-free subtotal or the tax the customer saved — they do NOT lower what was paid (the 合計 already excludes that tax). Put every such line in ignoredLines[] and NEVER create a TAX_EXEMPT (or any) adjustment for it — doing so would wrongly subtract the tax a second time. Reserve TAX_EXEMPT only for a rare explicit exemption line that VISIBLY lowers the amount due below the item subtotal.',
    '- Japan/Taiwan included-tax vocabulary: 内税 / 內稅 / 税込 / 含稅 / 軽税 / 軽減税率 usually identify included tax or a reduced-rate category — put them in ignoredLines[] unless the line is explicitly added to a pre-tax subtotal.',
    '',
    'Total selection:',
    '- "totalText" is the receipt grand total / amount due / amount paid by the customer after visible modifiers. Prefer labels such as 合計, お買上げ合計, ご請求額, 領収金額, 支払金額, Total.',
    '- Do not use cash tendered / amount received / change as totalText: お預り, 預り, お釣り, 釣銭, change.',
    '- The identity sum(items[].amountText) + Σ(adjustment sign × adjustment.amountText) should match totalText when the receipt is legible, but NEVER invent an adjustment to make it match. If visible lines do not reconcile, output the best visible extraction and leave metadata in ignoredLines[].',
    '',
    'Store/category:',
    '- "storeName" is the store, restaurant, or venue name printed at the top of the receipt. Use the most prominent / largest name (skip branch numbers, addresses, phone numbers). Omit if no clear store identifier exists.',
    '- "category" is the most likely expense category for this receipt. Choose ONE from this fixed list, based on the storeName + line items:',
    '    - food          : restaurants, cafés, bars, supermarkets, convenience stores, takeout, drinks (居酒屋 / カフェ / レストラン / コンビニ / スーパー / 食堂)',
    '    - transport     : trains, taxis, buses, flights, fuel, parking, tolls, IC card top-ups (タクシー / JR / 地下鉄 / バス / ガソリン / 駐車場 / Suica)',
    '    - accommodation : hotels, ryokan, hostels, Airbnb, lodging fees (ホテル / 旅館 / 民宿)',
    '    - activity      : tickets, museums, theme parks, tours, experiences, attractions (チケット / 入場料 / ツアー / 美術館)',
    '    - shopping      : clothing, electronics, souvenirs, drugstores, department stores, non-food retail (服 / 雑貨 / お土産 / ドラッグストア / 百貨店)',
    '    - other         : anything that does not clearly fit above (medical, ATM fees, services, mixed receipts where intent is unclear)',
    '  Omit "category" only when truly indeterminable. Prefer guessing over omitting.',
    '- If the receipt is unreadable, return items: [], adjustments: [], ignoredLines: [] and totalText: "0".',
    currencyHint
      ? `- Currency hint: ${currencyHint} (use this when the receipt symbol is ambiguous).`
      : '',
  ].filter(Boolean).join('\n')
}

export class OcrError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}
