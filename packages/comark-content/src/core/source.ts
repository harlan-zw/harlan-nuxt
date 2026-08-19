import type { CollectionDefinition, CollectionSource } from '../config'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'

export interface ResolvedSource {
  cwd: string
  include: string
  exclude: string[]
  prefix: string
  repository?: Exclude<CollectionSource, string>['repository']
}

const escapeRegex = (value: string) => value.replaceAll(/[|\\{}()[\]^$+?.]/g, '\\$&')

export function globRegex(glob: string) {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]
    const next = glob[index + 1]
    if (character === '*' && next === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      }
      else {
        source += '.*'
        index += 1
      }
      continue
    }
    if (character === '*') {
      source += '[^/]*'
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    if (character === '{') {
      const end = glob.indexOf('}', index)
      if (end !== -1) {
        source += `(?:${glob.slice(index + 1, end).split(',').map(escapeRegex).join('|')})`
        index = end
        continue
      }
    }
    source += escapeRegex(character ?? '')
  }
  return new RegExp(`^${source}$`)
}

function sourceBase(include: string) {
  const wildcard = include.search(/[*?{]/)
  const directory = wildcard === -1 ? posix.dirname(include) : include.slice(0, wildcard).replace(/[^/]*$/, '')
  return directory === '.' ? '' : directory.replace(/^\/+|\/+$/g, '')
}

export function resolveCollectionSource(definition: CollectionDefinition, rootDir: string, remoteCwd?: string): ResolvedSource {
  const source = definition.source ?? '**/*.md'
  if (typeof source === 'string') {
    return {
      cwd: resolve(rootDir, 'content'),
      include: source,
      exclude: [],
      prefix: '',
    }
  }
  const localCwd = source.cwd
    ? isAbsolute(source.cwd) ? source.cwd : resolve(rootDir, source.cwd)
    : resolve(rootDir, 'content')
  return {
    cwd: remoteCwd ?? localCwd,
    include: source.include,
    exclude: typeof source.exclude === 'string' ? [source.exclude] : source.exclude ?? [],
    prefix: source.prefix ?? '',
    repository: source.repository,
  }
}

export async function scanSource(source: ResolvedSource) {
  const include = globRegex(source.include)
  const excludes = source.exclude.map(globRegex)
  const base = sourceBase(source.include)
  const files: Array<{ key: string, path: string }> = []
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md'))
        continue
      const key = relative(source.cwd, path).replaceAll('\\', '/')
      if (include.test(key) && !excludes.some(pattern => pattern.test(key))) {
        const sourceKey = base && key.startsWith(`${base}/`) ? key.slice(base.length + 1) : key
        files.push({ key: sourceKey, path })
      }
    }
  }
  await visit(source.cwd)
  return files.sort((left, right) => left.key.localeCompare(right.key))
}

const markdownWatchEvents = new Set(['add', 'change', 'unlink'])

/**
 * Reports whether a watcher event changed a Markdown file.
 * Added and deleted files count, so a rebuild needs no restart.
 */
export function isMarkdownWatchEvent(event: string, path: string): boolean {
  return markdownWatchEvents.has(event) && path.endsWith('.md')
}
