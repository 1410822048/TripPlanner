import { setPerfMetric } from './perf'

interface LargestContentfulPaintEntry extends PerformanceEntry {
  element: Element | null
  size: number
}

interface LayoutShiftSource {
  node?: Node | null
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
  sources?: LayoutShiftSource[]
}

function elementLabel(node: Node | null | undefined): string | undefined {
  if (!(node instanceof Element)) return undefined
  const id = node.id ? `#${node.id}` : ''
  const classes = Array.from(node.classList).slice(0, 2).map(name => `.${name}`).join('')
  return `${node.tagName.toLowerCase()}${id}${classes}`.slice(0, 120)
}

function observeLcp(): void {
  try {
    const observer = new PerformanceObserver(list => {
      const entries = list.getEntries() as LargestContentfulPaintEntry[]
      const latest = entries.at(-1)
      if (!latest) return
      setPerfMetric({
        name: 'LCP',
        value: latest.startTime,
        detail: elementLabel(latest.element),
      })
    })
    observer.observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {
    // Unsupported PerformanceObserver entry type — debug instrumentation
    // must never affect application boot.
  }
}

function observeCls(): void {
  let sessionValue = 0
  let maxSessionValue = 0
  let sessionStart = 0
  let lastShift = 0

  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as LayoutShiftEntry[]) {
        if (entry.hadRecentInput) continue

        const belongsToSession = lastShift > 0
          && entry.startTime - lastShift < 1000
          && entry.startTime - sessionStart < 5000
        if (belongsToSession) {
          sessionValue += entry.value
        } else {
          sessionValue = entry.value
          sessionStart = entry.startTime
        }
        lastShift = entry.startTime

        if (sessionValue <= maxSessionValue) continue
        maxSessionValue = sessionValue
        setPerfMetric({
          name: 'CLS',
          value: maxSessionValue,
          detail: elementLabel(entry.sources?.[0]?.node),
        })
      }
    })
    observer.observe({ type: 'layout-shift', buffered: true })
  } catch {
    // See observeLcp: unsupported metrics degrade to an absent debug row.
  }
}

export function startWebVitalsDebug(): void {
  observeLcp()
  observeCls()
}
