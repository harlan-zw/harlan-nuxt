import type { WideEventRecord } from './index'
import type { StandaloneWideEventLevel } from './standalone-core'

export interface DevelopmentWideEventRecord extends Record<string, string | number | boolean | null | undefined> {
  durationMs: number
  level: StandaloneWideEventLevel
  method: string
  requestId: string
  status: number
  timestamp: string
  path?: string
  service?: string
}

interface DevelopmentWideEventFormatOptions {
  colors?: boolean
}

const ANSI = {
  cyan: '\u001B[36m',
  dim: '\u001B[2m',
  gray: '\u001B[90m',
  green: '\u001B[32m',
  red: '\u001B[31m',
  reset: '\u001B[0m',
  yellow: '\u001B[33m',
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
  const colors = options.colors ?? supportsColor()
  const message = typeof record.devMessage === 'string'
    ? safeTerminalText(record.devMessage)
    : undefined
  const messageLines = message?.split('\n')
  const scope = typeof record.scope === 'string' ? record.scope : undefined
  const tag = safeTerminalText(record.service ?? scope ?? 'Wide Event')
  const level = record.level.toUpperCase()
  const request = record.path !== undefined
  const header = [
    paint(formatTimestamp(record.timestamp), ANSI.dim, colors),
    paint(level, levelColor(record.level), colors),
    paint(`[${tag}]`, ANSI.cyan, colors),
  ]

  if (request) {
    header.push(`${safeTerminalText(record.method)} ${safeTerminalText(record.path ?? '')}`)
    header.push(paint(String(record.status), record.status >= 400 ? ANSI.red : ANSI.green, colors))
    header.push(paint(`in ${formatDuration(record.durationMs)}`, ANSI.dim, colors))
  }
  if (messageLines?.[0])
    header.push(messageLines[0])

  const lines = [header.join(' ')]
  if (messageLines && messageLines.length > 1)
    lines.push(...indentMessageLines(messageLines.slice(1)))

  const fields = Object.entries(record)
    .filter(([key, value]) => value !== undefined && !isHeaderField(key))
    .filter(([key]) => key !== 'devMessage' && !(key === 'scope' && scope !== undefined))
    .sort(([left], [right]) => Number(left === 'requestId') - Number(right === 'requestId'))

  for (const [index, [key, value]] of fields.entries()) {
    if (value === undefined)
      continue
    lines.push(...formatField(key, value, index === fields.length - 1, colors))
  }

  return lines.join('\n')
}

/** Write one development Wide Event without framework console decoration. */
export function writeDevelopmentWideEvent(record: DevelopmentWideEventRecord): void {
  const output = formatDevelopmentWideEvent(record)
  const stdout = runtimeProcess()?.stdout
  if (stdout?.write) {
    stdout.write(`${output}\n`)
    return
  }
  console.log(output)
}

function formatField(key: string, value: string | number | boolean | null, last: boolean, colors: boolean): string[] {
  const branch = last ? '└─' : '├─'
  const continuation = last ? '  ' : '│ '
  const valueLines = safeTerminalText(String(value)).split('\n')
  return [
    `  ${paint(branch, ANSI.dim, colors)} ${paint(`${safeTerminalText(key)}:`, ANSI.cyan, colors)} ${valueLines[0] ?? ''}`,
    ...valueLines.slice(1).map(line => `  ${paint(continuation, ANSI.dim, colors)}   ${line}`),
  ]
}

function formatTimestamp(timestamp: string): string {
  return timestamp.length >= 23 ? timestamp.slice(11, 23) : safeTerminalText(timestamp)
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

function levelColor(level: StandaloneWideEventLevel): string {
  switch (level) {
    case 'debug':
      return ANSI.gray
    case 'error':
      return ANSI.red
    case 'warn':
      return ANSI.yellow
    default:
      return ANSI.cyan
  }
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

function supportsColor(): boolean {
  const process = runtimeProcess()
  return process !== undefined && process.env.NO_COLOR === undefined && process.stdout?.isTTY === true
}

function runtimeProcess(): {
  env: Record<string, string | undefined>
  stdout?: { isTTY?: boolean, write?: (output: string) => unknown }
} | undefined {
  return Reflect.get(globalThis, 'process') as {
    env: Record<string, string | undefined>
    stdout?: { isTTY?: boolean, write?: (output: string) => unknown }
  } | undefined
}
