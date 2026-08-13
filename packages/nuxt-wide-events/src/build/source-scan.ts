import type { WideEventSourceIssue } from './source-validation'
import { readdir, readFile } from 'node:fs/promises'
import { join, normalize, relative } from 'pathe'
import { formatWideEventSourceIssues, validateWideEventSource } from './source-validation'

const SOURCE_PATTERN = /\.[cm]?[jt]sx?$/i
const IGNORED_PATTERN = /(?:^|\/)(?:node_modules|\.nuxt|\.output|dist)(?:\/|$)|\.(?:d|test|spec)\.[cm]?[jt]sx?$/i

export async function assertWideEventSources(rootDir: string, roots: readonly string[], fields: ReadonlySet<string>): Promise<void> {
  const files = (await Promise.all(roots.map(root => findSourceFiles(root)))).flat()
  const issues = (await Promise.all(files.map(async file => validateFile(rootDir, file, fields)))).flat()
  if (issues.length > 0)
    throw new Error(`[nuxt-wide-events]\n${formatWideEventSourceIssues(issues)}`)
}

export async function assertWideEventSourceFile(rootDir: string, file: string, fields: ReadonlySet<string>): Promise<void> {
  const issues = await validateFile(rootDir, file, fields)
  if (issues.length > 0)
    throw new Error(`[nuxt-wide-events]\n${formatWideEventSourceIssues(issues)}`)
}

export function isWideEventSourceFile(file: string, roots: readonly string[]): boolean {
  const normalized = normalize(file)
  return SOURCE_PATTERN.test(normalized)
    && !IGNORED_PATTERN.test(normalized)
    && roots.some(root => normalized === normalize(root) || normalized.startsWith(`${normalize(root)}/`))
}

async function validateFile(rootDir: string, file: string, fields: ReadonlySet<string>): Promise<WideEventSourceIssue[]> {
  const source = await readFile(file, 'utf8')
  const result = validateWideEventSource(source, normalize(relative(rootDir, file)), fields)
  return result._tag === 'Err' ? result.issues : []
}

async function findSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await findSourceFiles(file))
      continue
    }
    if (SOURCE_PATTERN.test(file) && !IGNORED_PATTERN.test(file))
      files.push(file)
  }
  return files
}
