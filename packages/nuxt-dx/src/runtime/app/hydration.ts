/**
 * Vue reports hydration mismatches through `warnHandler`, where the DOM nodes it passed as
 * warning arguments have already been flattened into the message with `String(node)`. Everything
 * here works off that flattened string so it stays pure and testable outside a browser.
 */

export type HydrationMismatchKind = 'node' | 'text' | 'children' | 'class' | 'style' | 'attribute'

export interface HydrationMismatch {
  kind: HydrationMismatchKind
  /** The DOM interface Vue reported the mismatch on, such as `HTMLParagraphElement`. */
  element?: string
  /** What the server sent down. */
  server?: string
  /** What the first client render produced. */
  client?: string
  /** The sentence Vue attaches when there is no server/client pair to show. */
  detail?: string
}

const MISMATCH_KINDS: readonly (readonly [string, HydrationMismatchKind])[] = [
  ['Hydration node mismatch', 'node'],
  ['Hydration text content mismatch', 'text'],
  ['Hydration text mismatch', 'text'],
  ['Hydration children mismatch', 'children'],
  ['Hydration class mismatch', 'class'],
  ['Hydration style mismatch', 'style'],
  ['Hydration attribute mismatch', 'attribute'],
]

const MISMATCH_LABELS: Record<HydrationMismatchKind, string> = {
  node: 'Node mismatch',
  text: 'Text mismatch',
  children: 'Children mismatch',
  class: 'Class mismatch',
  style: 'Style mismatch',
  attribute: 'Attribute mismatch',
}

/** Vue's internal vnode type symbols, which reach the warning as their `toString()`. */
const VNODE_SYMBOLS: Record<string, string> = {
  'Symbol(v-cmt)': 'comment node (a v-if placeholder)',
  'Symbol(v-fgt)': 'fragment',
  'Symbol(v-txt)': 'text node',
  'Symbol(v-stc)': 'static vnode',
}

const SERVER_MARKER = '- rendered on server:'
const CLIENT_MARKER = '- expected on client:'
const NOTE_MARKER = '\n  Note:'

/** Vue logs this once per hydration pass, after it has already warned about every mismatch. */
export const HYDRATION_SUMMARY_ERROR = 'Hydration completed but contains mismatches.'

function readNodeToken(raw: string): string | undefined {
  const token = raw.trim()
  if (!token)
    return undefined
  if (token in VNODE_SYMBOLS)
    return VNODE_SYMBOLS[token]
  // Vue appends a hint such as `(text)` after the node it stringified.
  const objectTag = /^\[object (\w+)\] ?(.*)$/.exec(token)
  return objectTag ? `${objectTag[1]}${objectTag[2] ? ` ${objectTag[2]}` : ''}` : token
}

function readSegment(message: string, marker: string, stopAt: readonly string[]): string | undefined {
  const start = message.indexOf(marker)
  if (start < 0)
    return undefined
  const rest = message.slice(start + marker.length)
  const stop = stopAt
    .map(end => rest.indexOf(end))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0]
  // Vue writes `: ` before the value, so one leading space is punctuation rather than content.
  const value = (stop === undefined ? rest : rest.slice(0, stop)).replace(/^ /, '').replace(/\s+$/, '')
  return value || undefined
}

export function parseHydrationWarning(message: string): HydrationMismatch | undefined {
  const kind = MISMATCH_KINDS.find(([prefix]) => message.startsWith(prefix))?.[1]
  if (!kind)
    return undefined

  const [head = '', ...tail] = message.split('\n')
  const server = readSegment(message, SERVER_MARKER, [CLIENT_MARKER])
  const client = readSegment(message, CLIENT_MARKER, [NOTE_MARKER])
  // A node mismatch names no host element: both sides of the pair are nodes rather than values.
  const isNode = kind === 'node'

  return {
    kind,
    element: isNode ? undefined : readNodeToken(/mismatch (?:on|in)(.*)$/.exec(head)?.[1] ?? ''),
    server: isNode ? readNodeToken(server ?? '') : server,
    client: isNode ? readNodeToken(client ?? '') : client,
    detail: server || client ? undefined : tail.join('\n').trim() || undefined,
  }
}

/** Turns Vue's `at <Foo>` component trace into the component chain, nearest first. */
export function parseComponentTrace(trace: string): string[] {
  return trace
    .split('\n')
    .map(line => /^\s*at <([^\s>]+)/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
}

export function hydrationMismatchLabel(kind: HydrationMismatchKind): string {
  return MISMATCH_LABELS[kind]
}
