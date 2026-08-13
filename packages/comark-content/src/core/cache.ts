import type { MarkdownDocument } from 'comark'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CACHE_VERSION = 'comark-content:1:comark-0.6.2'

export type CacheEntry = {
  digest: string
  document: MarkdownDocument
}

export type IngestionCache = {
  version: string
  entries: Record<string, CacheEntry>
}

export const readCache = async (path: string): Promise<IngestionCache> => {
  const source = await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (!source)
    return { version: CACHE_VERSION, entries: {} }
  const parsed = JSON.parse(source) as IngestionCache
  return parsed.version === CACHE_VERSION ? parsed : { version: CACHE_VERSION, entries: {} }
}

export const writeCache = async (path: string, cache: IngestionCache) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(cache)}\n`)
  await rename(temporary, path)
}
