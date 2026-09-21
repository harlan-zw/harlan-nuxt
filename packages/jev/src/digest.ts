import { digest } from 'ohash'

// Digest keys must be stable across processes and key order: sort recursively.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function digestKey(input: string): string {
  return digest(input)
}
