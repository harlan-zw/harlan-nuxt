import type { WideEventKind, WideEventLevel, WideEventRecord } from './index'

export interface DevelopmentWideEventRecord extends Record<string, string | number | boolean | null | undefined> {
  durationMs: number
  kind: WideEventKind
  level: WideEventLevel
  requestId: string
  timestamp: string
  method?: string
  path?: string
  service?: string
  status?: number
}

interface DevelopmentWideEventFormatOptions {
  colors?: boolean
  target?: 'stdout' | 'stderr'
}

interface DevelopmentValueField {
  _tag: 'Value'
  key: string
  value: string | number | boolean
}

interface DevelopmentGroupField {
  _tag: 'Group'
  key: string
  values: Array<{ key: string, value: string | number | boolean }>
}

type DevelopmentField = DevelopmentValueField | DevelopmentGroupField

const ANSI = {
  blue: '\u001B[38;2;137;180;250m',
  green: '\u001B[38;2;166;227;161m',
  mauve: '\u001B[38;2;203;166;247m',
  muted: '\u001B[38;2;147;153;178m',
  peach: '\u001B[38;2;250;179;135m',
  red: '\u001B[38;2;243;139;168m',
  reset: '\u001B[0m',
  teal: '\u001B[38;2;148;226;213m',
} as const

export function enrichDevelopmentWideEvent(record: WideEventRecord, error: unknown): DevelopmentWideEventRecord {
  if (typeof error !== 'object' || error === null)
    return record
  const input = error as Record<string, unknown>
  if (typeof input.name === 'string')
    record['error.name'] = input.name
  if (typeof input.message === 'string')
    record['error.message'] = input.message
  if (typeof input.stack === 'string')
    record['error.stack'] = input.stack
  return record
}

/** Format one Wide Event for compact development terminal output. */
export function formatDevelopmentWideEvent(
  record: DevelopmentWideEventRecord,
  options: DevelopmentWideEventFormatOptions = {},
): string {
  const colors = options.colors ?? supportsColor(options.target ?? 'stdout')
  const message = typeof record.devMessage === 'string'
    ? safeTerminalText(record.devMessage)
    : undefined
  const messageLines = message?.split('\n')
  const scope = typeof record.scope === 'string' ? record.scope : undefined
  const tag = safeTerminalText(record.service ?? scope ?? 'Wide Event')
  const level = record.level.toUpperCase()
  const request = record.kind === 'request'
  const header = [
    paint(level, levelColor(record.level), colors),
    paint(`[${tag}]`, ANSI.mauve, colors),
  ]

  if (request) {
    header.push(`${paint(safeTerminalText(record.method ?? ''), ANSI.blue, colors)} ${safeTerminalText(record.path ?? '')}`)
    header.push(paint(String(record.status), statusColor(record.status), colors))
    header.push(paint(formatDuration(record.durationMs), ANSI.muted, colors))
  }
  if (messageLines?.[0])
    header.push(messageLines[0])

  const fields = Object.entries(record)
    .filter(([key, value]) => value !== undefined && value !== null && !isHeaderField(key))
    .filter(([key]) => key !== 'devMessage' && !(key === 'scope' && scope !== undefined))
  const groupedFields = groupFields(fields.filter(([key]) => key !== 'requestId'))
  // Cloudflare context exists on every edge request, so keep it with the request metadata.
  const cloudflare = groupedFields.find(field => field.key === 'cf')
  if (cloudflare)
    header.push(formatHeadlineField(cloudflare, colors))
  header.push(formatHeadlineField({ _tag: 'Value', key: 'requestId', value: record.requestId }, colors))

  const lines = [header.join(' ')]
  if (messageLines && messageLines.length > 1)
    lines.push(...indentMessageLines(messageLines.slice(1)))

  const detailFields = groupedFields.filter(field => field.key !== 'cf')
  for (const [index, field] of detailFields.entries()) {
    lines.push(...formatField(field, index === detailFields.length - 1, colors))
  }

  return lines.join('\n')
}

/** Write one development Wide Event through its matching Console level. */
export function writeDevelopmentWideEvent(record: DevelopmentWideEventRecord): void {
  const target: 'stdout' | 'stderr' = record.level === 'warn' || record.level === 'error' ? 'stderr' : 'stdout'
  const output = formatDevelopmentWideEvent(record, { target })
  switch (record.level) {
    case 'debug':
      console.debug(output)
      return
    case 'error':
      console.error(output)
      return
    case 'info':
      console.info(output)
      return
    case 'warn':
      console.warn(output)
  }
}

function formatField(field: DevelopmentField, last: boolean, colors: boolean): string[] {
  const branch = last ? '└─' : '├─'
  const continuation = last ? '  ' : '│ '
  const valueLines = formatFieldValue(field, colors).split('\n')
  return [
    `  ${paint(branch, ANSI.muted, colors)} ${paint(`${safeTerminalText(field.key)}:`, ANSI.teal, colors)} ${valueLines[0] ?? ''}`,
    ...valueLines.slice(1).map(line => `  ${paint(continuation, ANSI.muted, colors)}   ${line}`),
  ]
}

function formatHeadlineField(field: DevelopmentField, colors: boolean): string {
  return `${paint('·', ANSI.muted, colors)} ${paint(`${field.key}:`, ANSI.teal, colors)} ${formatFieldValue(field, colors)}`
}

function formatFieldValue(field: DevelopmentField, colors: boolean): string {
  if (field._tag === 'Value')
    return safeTerminalText(String(field.value))
  return field.values
    .map(({ key, value }) => `${paint(safeTerminalText(key), ANSI.blue, colors)}${paint('=', ANSI.muted, colors)}${safeTerminalText(String(value))}`)
    .join(paint(', ', ANSI.muted, colors))
}

function groupFields(fields: Array<[string, string | number | boolean | null | undefined]>): DevelopmentField[] {
  const groups = new Map<string, DevelopmentGroupField>()
  const values: DevelopmentValueField[] = []

  for (const [key, value] of fields) {
    if (value === null || value === undefined)
      continue
    const separator = key.indexOf('.')
    if (separator < 1) {
      values.push({ _tag: 'Value', key, value })
      continue
    }
    const group = key.slice(0, separator)
    const child = key.slice(separator + 1)
    const grouped = groups.get(group)
    if (grouped)
      grouped.values.push({ key: child, value })
    else
      groups.set(group, { _tag: 'Group', key: group, values: [{ key: child, value }] })
  }

  return [...groups.values(), ...values]
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1)
    return '<1ms'
  if (durationMs < 1000)
    return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1000).toFixed(2)}s`
}

function indentMessageLines(lines: string[]): string[] {
  const populated = lines.filter(Boolean)
  const commonIndent = populated.length === 0
    ? 0
    : Math.min(...populated.map(line => line.length - line.trimStart().length))
  return lines.map(line => `  ${line.slice(commonIndent)}`)
}

function isHeaderField(field: string): boolean {
  switch (field) {
    case 'durationMs':
    case 'kind':
    case 'level':
    case 'method':
    case 'path':
    case 'service':
    case 'status':
    case 'timestamp':
      return true
    default:
      return false
  }
}

function levelColor(level: WideEventLevel): string {
  switch (level) {
    case 'debug':
      return ANSI.muted
    case 'error':
      return ANSI.red
    case 'warn':
      return ANSI.peach
    default:
      return ANSI.blue
  }
}

function statusColor(status: number | undefined): string {
  if (status === undefined)
    return ANSI.muted
  if (status >= 500)
    return ANSI.red
  if (status >= 400)
    return ANSI.peach
  if (status >= 300)
    return ANSI.blue
  return ANSI.green
}

function paint(value: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${value}${ANSI.reset}` : value
}

function safeTerminalText(value: string): string {
  let output = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (character === '\n' || (code >= 32 && (code < 127 || code > 159)))
      output += character
    else
      output += `\\u${code.toString(16).padStart(4, '0')}`
  }
  return output
}

function supportsColor(target: 'stdout' | 'stderr'): boolean {
  const process = runtimeProcess()
  if (process?.env.NO_COLOR !== undefined)
    return false
  const stream = target === 'stderr' ? process?.stderr : process?.stdout
  return stream?.isTTY === true || stream?.write === undefined
}

function runtimeProcess(): {
  env: Record<string, string | undefined>
  stdout?: { isTTY?: boolean, write?: (output: string) => unknown }
  stderr?: { isTTY?: boolean, write?: (output: string) => unknown }
} | undefined {
  return Reflect.get(globalThis, 'process') as {
    env: Record<string, string | undefined>
    stdout?: { isTTY?: boolean, write?: (output: string) => unknown }
    stderr?: { isTTY?: boolean, write?: (output: string) => unknown }
  } | undefined
}
