/**
 * Terminal formatting helpers for the `cf-jobs` CLI: ANSI colour, relative-time
 * rendering, column-aligned tables, and a small standard-cron next-run
 * calculator. All pure so they can be exercised without a TTY.
 */

const useColor = !process.env.NO_COLOR && process.stdout?.isTTY !== false

function wrap(open: number, close: number) {
  return (s: string | number) => (useColor ? `[${open}m${s}[${close}m` : String(s))
}

export const color = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
}

/** Compact duration: 45s, 3m, 2h, 5d. */
export function humanizeSeconds(seconds: number): string {
  const abs = Math.abs(Math.trunc(seconds))
  if (abs < 60)
    return `${abs}s`
  if (abs < 3600)
    return `${Math.floor(abs / 60)}m`
  if (abs < 86_400)
    return `${Math.floor(abs / 3600)}h`
  return `${Math.floor(abs / 86_400)}d`
}

/** Compact relative time. Positive = past ("3m ago"), negative = future ("in 2h"). */
export function relativeTime(unixSeconds: number | null | undefined, nowSeconds: number): string {
  if (unixSeconds == null)
    return '—'
  const delta = nowSeconds - unixSeconds
  if (delta === 0)
    return 'now'
  const unit = humanizeSeconds(delta)
  return delta > 0 ? `${unit} ago` : `in ${unit}`
}

export function truncate(value: unknown, max: number): string {
  const s = value == null ? '' : String(value)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Render an aligned table. `align` marks right-aligned (numeric) columns. */
export function table(headers: string[], rows: Array<Array<string | number>>, align: boolean[] = []): string {
  const all = [headers, ...rows.map(r => r.map(String))]
  const widths = headers.map((_, i) => Math.max(...all.map(r => stripAnsi(String(r[i] ?? '')).length)))
  const line = (cells: Array<string | number>, dim = false) =>
    cells
      .map((c, i) => {
        const str = String(c)
        const pad = widths[i]! - stripAnsi(str).length
        const padded = align[i] ? ' '.repeat(Math.max(0, pad)) + str : str + ' '.repeat(Math.max(0, pad))
        return dim ? color.dim(padded) : padded
      })
      .join('  ')
      .trimEnd()
  return [line(headers.map(h => color.bold(h))), ...rows.map(r => line(r))].join('\n')
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[\d+m/g, '')
}

// --- standard 5-field cron --------------------------------------------------

interface CronField {
  min: number
  max: number
}

const FIELDS: CronField[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
]

function parseField(spec: string, { min, max }: CronField): Set<number> | null {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step < 1)
      return null
    let lo = min
    let hi = max
    if (range !== '*' && range !== undefined) {
      const [a, b] = range.split('-')
      lo = Number(a)
      hi = b !== undefined ? Number(b) : (stepRaw ? max : Number(a))
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
        return null
    }
    for (let v = lo; v <= hi; v += step)
      out.add(v)
  }
  return out
}

const WHITESPACE_RE = /\s+/

/** Parse a 5-field cron into per-field allowed-value sets, or null if invalid. */
export function parseCron(expr: string): Array<Set<number>> | null {
  const parts = expr.trim().split(WHITESPACE_RE)
  if (parts.length !== 5)
    return null
  const sets: Array<Set<number>> = []
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i]!, FIELDS[i]!)
    if (!set)
      return null
    sets.push(set)
  }
  return sets
}

/**
 * Next UTC firing of a 5-field cron at or after `from`. Steps minute-by-minute
 * up to ~4 years; returns null for an invalid expression or no match in range.
 * Cloudflare cron triggers evaluate in UTC, so we match against UTC fields.
 */
export function nextCronRun(expr: string, from: Date): Date | null {
  const sets = parseCron(expr)
  if (!sets)
    return null
  const [minutes, hours, doms, months, dows] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  const t = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    from.getUTCHours(),
    from.getUTCMinutes() + 1,
    0,
    0,
  ))
  const domRestricted = doms.size !== 31
  const dowRestricted = dows.size !== 7
  const limit = 366 * 4 * 24 * 60
  for (let i = 0; i < limit; i++) {
    const month = t.getUTCMonth() + 1
    const dom = t.getUTCDate()
    const dow = t.getUTCDay()
    // Standard cron OR-semantics: when both day fields are restricted a match in
    // either fires; when one is `*` both must hold.
    const dayOk = domRestricted && dowRestricted
      ? doms.has(dom) || dows.has(dow)
      : doms.has(dom) && dows.has(dow)
    if (
      months.has(month)
      && dayOk
      && hours.has(t.getUTCHours())
      && minutes.has(t.getUTCMinutes())
    ) {
      return t
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1)
  }
  return null
}
