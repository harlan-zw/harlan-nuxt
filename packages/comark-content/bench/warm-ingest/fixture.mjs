// Builds a corpus the size of the nuxtseo.com docs site: 17 collections, 389
// Markdown files, about 14 MB of parsed documents in the ingest cache.
// Set COMARK_BENCH_CORPUS to a colon separated list to point it elsewhere.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const DEFAULT_CORPUS = [
  'pkg/nuxt-robots/docs/content',
  'pkg/sitemap/docs/content',
  'pkg/og-image/docs/content',
  'pkg/nuxt-schema-org/docs/content',
  'pkg/nuxt-seo-utils/docs/content',
  'pkg/nuxt-link-checker/docs/content',
  'pkg/nuxt-site-config/docs/content',
  'pkg/nuxt-skew-protection/docs/content',
  'pkg/nuxt-ai-ready/docs/content',
  'sites/nuxtseo.com/apps/site/content',
].map(path => resolve(homedir(), path))

const COLLECTION_COUNT = 17
const FILE_COUNT = 389

function corpusRoots() {
  const configured = process.env.COMARK_BENCH_CORPUS
  return configured ? configured.split(':').filter(Boolean) : DEFAULT_CORPUS
}

async function walk(directory) {
  const found = []
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      found.push(...await walk(path))
    else if (entry.name.endsWith('.md'))
      found.push(path)
  }
  return found
}

export async function buildFixture(root) {
  await rm(root, { recursive: true, force: true })
  const sources = []
  for (const corpus of corpusRoots())
    sources.push(...await walk(corpus))
  if (!sources.length)
    throw new Error(`No Markdown found. Set COMARK_BENCH_CORPUS to a colon separated list of content directories.`)
  sources.sort()
  const documents = await Promise.all(sources.map(path => readFile(path, 'utf8')))
  const collections = []
  for (let index = 0; index < COLLECTION_COUNT; index++) {
    const name = `collection${String(index).padStart(2, '0')}`
    await mkdir(join(root, 'content', name), { recursive: true })
    collections.push(name)
  }
  for (let index = 0; index < FILE_COUNT; index++) {
    const collection = collections[index % COLLECTION_COUNT]
    const document = documents[index % documents.length]
    await writeFile(join(root, 'content', collection, `doc-${String(index).padStart(4, '0')}.md`), document)
  }
  return collections
}
