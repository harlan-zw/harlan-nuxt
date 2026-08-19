import { posix } from 'node:path'

const SEMVER = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/

function stripOrder(part: string) {
  return SEMVER.test(part)
    ? part
    : part.replace(/^\d+\./, '')
}

export const sourceStem = (key: string) => key.replace(/\.md$/i, '')

export function contentPath(key: string, prefix = '') {
  const parts = sourceStem(key).split('/').map(stripOrder)
  const last = parts.at(-1)?.toLowerCase()
  if (last === 'index')
    parts.pop()
  const joined = posix.join('/', prefix, ...parts)
  return joined === '/' ? '/' : joined.replace(/\/$/, '')
}
