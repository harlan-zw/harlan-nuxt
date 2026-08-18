import type { ContractQuerySourceFile, ResolvedContractQueryEnforcementOptions } from './types'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { normalize } from 'pathe'
import { createDirectoryMatcher, normalizePattern, segmentPatternToRegExp } from './options'

const SOURCE_READ_CONCURRENCY = 32

interface DiscoveredSourceFile {
  file: string
  path: string
}

export async function readSourceFilesFromDisk(rootDir: string, options: ResolvedContractQueryEnforcementOptions): Promise<ContractQuerySourceFile[]> {
  const discovered: DiscoveredSourceFile[] = []
  // `ignore` shares the matcher used by `queryDirs` and `contractDirs`, so one
  // pattern means the same thing in every option.
  const isIgnored = createDirectoryMatcher(options.ignore)
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

  for (const dir of await expandScanDirs(rootDir, options.scanDirs, isIgnored))
    await walk(dir)

  return mapConcurrent(discovered, SOURCE_READ_CONCURRENCY, async ({ file, path }) => ({
    file,
    source: await readFile(path, 'utf8'),
  }))
}

/**
 * Expand `scanDirs` entries into absolute directory paths. Every segment may
 * hold a wildcard: `*` matches one directory name, `**` matches any depth. A
 * layered site keeps its code under `layers/<layer>/<site>/app`, so a pattern
 * has to survive more than one wildcard to reach it.
 */
async function expandScanDirs(
  rootDir: string,
  patterns: string[],
  isIgnored: (path: string) => boolean,
): Promise<string[]> {
  const expanded = new Set<string>()
  for (const pattern of patterns) {
    const segments = normalizePattern(pattern).split('/').filter(segment => segment && segment !== '.')
    for (const dir of await expandSegments(rootDir, segments, rootDir, isIgnored))
      expanded.add(dir)
  }
  return [...expanded]
}

async function expandSegments(
  dir: string,
  segments: string[],
  rootDir: string,
  isIgnored: (path: string) => boolean,
): Promise<string[]> {
  const [head, ...rest] = segments
  // `walk` tolerates a scan root that does not exist, so a literal tail needs
  // no existence check here.
  if (head == null)
    return [dir]

  if (head === '**') {
    // `**` matches this directory plus every descendant.
    const matched = await expandSegments(dir, rest, rootDir, isIgnored)
    for (const child of await listChildDirectories(dir, rootDir, isIgnored))
      matched.push(...await expandSegments(child, segments, rootDir, isIgnored))
    return matched
  }

  if (head.includes('*') || head.includes('?')) {
    const matchesSegment = segmentPatternToRegExp(head)
    const matched: string[] = []
    for (const child of await listChildDirectories(dir, rootDir, isIgnored)) {
      if (matchesSegment.test(basename(child)))
        matched.push(...await expandSegments(child, rest, rootDir, isIgnored))
    }
    return matched
  }

  const next = join(dir, head)
  if (isIgnored(normalize(relative(rootDir, next))))
    return []
  return expandSegments(next, rest, rootDir, isIgnored)
}

async function listChildDirectories(
  dir: string,
  rootDir: string,
  isIgnored: (path: string) => boolean,
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  }
  catch {
    // Wildcard scan roots are optional and commonly absent.
    return []
  }
  const directories: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue
    const path = join(dir, entry.name)
    if (isIgnored(normalize(relative(rootDir, path))))
      continue
    directories.push(path)
  }
  return directories
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
