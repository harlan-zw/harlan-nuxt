// Measures the all-cache-hit ingest: the work every build repeats when no
// Markdown changed. Run with `pnpm bench:warm-ingest`.
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { createJiti } from 'jiti'
import { buildFixture } from './fixture.mjs'

const SAMPLES = Number(process.env.SAMPLES ?? 5)
const PACKAGE_ROOT = resolve(import.meta.dirname, '../..')

// Mirrors the highlight options nuxtseo.com builds with.
const HIGHLIGHT = {
  languages: {
    dir: [
      [/[|├└│]──/g, 'oper'],
      [/\b[\w-]+\/$/gm, 'class'],
      [/\b[\w-]+\.[a-z0-9]+$/gim, 'str'],
    ],
  },
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
}

async function main() {
  const jiti = createJiti(import.meta.url)
  const { ingestCollections } = await jiti.import(join(PACKAGE_ROOT, 'src/core/ingest.ts'))
  const { createContentAssetPlan, createContentRevision, syncContentAssets } = await jiti.import(join(PACKAGE_ROOT, 'src/core/asset.ts'))

  const root = join(tmpdir(), 'comark-warm-ingest')
  const outputDir = join(root, 'generated')
  const cacheFile = join(root, '.data/cache.json')
  const names = await buildFixture(root)
  const loaded = names.map(name => ({
    name,
    rootDir: root,
    definition: { type: 'page', source: { include: '**/*.md', cwd: join(root, 'content', name) } },
  }))

  const buildCollections = async () => {
    const marks = {}
    let at = performance.now()
    const result = await ingestCollections(loaded, { cacheFile, remoteCacheDir: join(root, '.remote'), highlight: HIGHLIGHT })
    marks.ingest = performance.now() - at
    if (result._tag === 'Err')
      throw new Error(JSON.stringify(result.error))
    at = performance.now()
    const revision = createContentRevision(result.value.collections)
    marks.revision = performance.now() - at
    at = performance.now()
    const sync = await syncContentAssets({
      outputDir,
      revision,
      reuseUnchanged: true,
      createPlan: () => createContentAssetPlan({
        collections: result.value.collections,
        sitemapCollections: result.value.sitemapCollections,
      }),
    })
    marks.assets = performance.now() - at
    return { result, marks, sync }
  }

  const coldStart = performance.now()
  const cold = await buildCollections()
  console.log(`cold: ${(performance.now() - coldStart).toFixed(1)}ms (${cold.result.value.parsedFiles} parsed, assets ${cold.sync._tag})`)

  const samples = []
  const phases = []
  for (let index = 0; index < SAMPLES; index++) {
    const startedAt = performance.now()
    const { result, marks, sync } = await buildCollections()
    samples.push(performance.now() - startedAt)
    if (result.value.parsedFiles !== 0)
      throw new Error(`Expected an all-cache-hit run, parsed ${result.value.parsedFiles}.`)
    phases.push({ ...marks, sync: sync._tag })
  }

  console.log(`warm samples: ${[...samples].sort((left, right) => left - right).map(value => value.toFixed(1)).join(', ')}`)
  console.log(`warm median: ${median(samples).toFixed(1)}ms (assets ${phases[0].sync})`)
  for (const key of ['ingest', 'revision', 'assets'])
    console.log(`  ${key}: ${median(phases.map(entry => entry[key])).toFixed(1)}ms`)
}

main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
