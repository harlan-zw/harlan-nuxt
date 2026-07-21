import type { ContractQuerySourceFile, ResolvedContractQueryEnforcementOptions } from './types'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { normalize } from 'pathe'

const SOURCE_READ_CONCURRENCY = 32

interface DiscoveredSourceFile {
  file: string
  path: string
}

export async function readSourceFilesFromDisk(rootDir: string, options: ResolvedContractQueryEnforcementOptions): Promise<ContractQuerySourceFile[]> {
  const discovered: DiscoveredSourceFile[] = []
  const isIgnored = createIgnoreMatcher(options.ignore)
  const seen = new Set<string>()

  async function walk(dir: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      // Scan roots are optional and commonly absent in smaller Nuxt projects.
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const rel = normalize(relative(rootDir, path))
      if (isIgnored(rel))
        continue
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!/\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name))
        continue
      if (seen.has(rel))
        continue
      seen.add(rel)
      discovered.push({
        file: rel,
        path,
      })
    }
  }

  for (const dir of await expandScanDirs(rootDir, options.scanDirs))
    await walk(dir)

  return mapConcurrent(discovered, SOURCE_READ_CONCURRENCY, async ({ file, path }) => ({
    file,
    source: await readFile(path, 'utf8'),
  }))
}

export function createIgnoreMatcher(patterns: string[]): (path: string) => boolean {
  const matchers = patterns.map((pattern) => {
    const normalized = normalize(pattern).replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
    const hasDirectory = normalized.includes('/')
    const hasGlob = /[*?]/.test(normalized)

    if (!hasGlob) {
      return hasDirectory
        ? (path: string) => path === normalized || path.startsWith(`${normalized}/`)
        : (path: string) => normalize(path).split('/').includes(normalized)
    }

    const expression = globPatternToRegExp(normalized)
    return hasDirectory
      ? (path: string) => expression.test(normalize(path))
      : (path: string) => expression.test(basename(path))
  })

  return path => matchers.some(matches => matches(path))
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        }
        else {
          source += '.*'
        }
      }
      else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * Expand `scanDirs` entries into absolute directory paths. Supports a single
 * `*` segment per pattern (e.g. `layers/*\/app`) by listing the parent dir and
 * appending the tail.
 */
async function expandScanDirs(rootDir: string, patterns: string[]): Promise<string[]> {
  const out: string[] = []
  for (const pattern of patterns) {
    const parts = pattern.split('/')
    const starIndex = parts.indexOf('*')
    if (starIndex === -1) {
      out.push(join(rootDir, ...parts))
      continue
    }
    const head = parts.slice(0, starIndex)
    const tail = parts.slice(starIndex + 1)
    const parent = join(rootDir, ...head)
    let entries
    try {
      entries = await readdir(parent, { withFileTypes: true })
    }
    catch {
      // Wildcard scan roots are optional and commonly absent.
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue
      const candidate = join(parent, entry.name, ...tail)
      if (tail.length === 0) {
        out.push(candidate)
        continue
      }
      const exists = await stat(candidate).then(s => s.isDirectory(), () => false)
      if (exists)
        out.push(candidate)
    }
  }
  return out
}

async function mapConcurrent<T, U>(
  items: readonly T[],
  concurrency: number,
  transform: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = []
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await transform(items[index]!)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
