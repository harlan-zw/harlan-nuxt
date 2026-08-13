import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { gzipSync } from 'node:zlib'

const NODE_VERSION = 'v24.17.0'
const PNPM_VERSION = '11.2.1'
const SAMPLE_COUNT = 10
const SITE_ROOT = '/home/harlan/sites/harlanzw.com'
const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const RESULTS_ROOT = resolve(import.meta.dirname, 'results')
const CONTENT_MARKERS = {
  baseline: [
    '__nuxt_content',
    '@nuxt/content',
    'ContentRenderer',
    'queryCollection',
    'minimark',
    'sqlite3',
  ],
  candidate: [
    '__comark_content',
    'comark-content',
    'ContentRenderer',
    'queryCollection',
  ],
}

const parseArgs = (args) => {
  const variantIndex = args.indexOf('--variant')
  const variant = variantIndex === -1 ? 'baseline' : args[variantIndex + 1]
  if (variant !== 'baseline' && variant !== 'candidate')
    throw new Error('Expected --variant baseline or --variant candidate.')
  return { variant }
}

const stripAnsi = value => value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')

const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
  const startedAt = performance.now()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.on('error', reject)
  child.on('close', (code) => {
    const durationMs = performance.now() - startedAt
    if (code === 0) {
      resolveRun({ durationMs, output: stripAnsi(output) })
      return
    }
    reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.\n${stripAnsi(output).slice(-8000)}`))
  })
})

const commandOutput = async (command, args, cwd) => {
  const result = await run(command, args, { cwd, env: process.env })
  return result.output.trim()
}

const assertEnvironment = async () => {
  if (process.version !== NODE_VERSION)
    throw new Error(`Expected Node ${NODE_VERSION}, received ${process.version}.`)
  const pnpmVersion = await commandOutput('pnpm', ['--version'], process.cwd())
  if (pnpmVersion !== PNPM_VERSION)
    throw new Error(`Expected pnpm ${PNPM_VERSION}, received ${pnpmVersion}.`)
}

const shouldCopy = (source) => {
  const name = basename(source)
  if (['.git', '.nuxt', '.output', '.data', '.wrangler', '.cache', 'coverage', 'dist', 'node_modules'].includes(name))
    return false
  if (name === '.cf-tokens' || name.startsWith('.env'))
    return false
  return true
}

const resetBuildState = async (siteRoot, sampleRoot, fontCacheRoot) => {
  await Promise.all([
    '.nuxt',
    '.output',
    '.data',
    '.cache',
    '.wrangler',
    'node_modules/.cache',
    'node_modules/.vite',
  ].map(path => rm(join(siteRoot, path), { recursive: true, force: true })))
  await rm(sampleRoot, { recursive: true, force: true })
  await mkdir(join(sampleRoot, 'cache'), { recursive: true })
  await mkdir(join(sampleRoot, 'tmp'), { recursive: true })
  await cp(fontCacheRoot, join(siteRoot, 'node_modules/.cache/nuxt/fonts/meta'), { recursive: true })
}

const benchmarkEnvironment = (sampleRoot) => ({
  ...process.env,
  CI: '1',
  NUXT_TELEMETRY_DISABLED: '1',
  XDG_CACHE_HOME: join(sampleRoot, 'cache'),
  TMPDIR: join(sampleRoot, 'tmp'),
  SENTRY_AUTH_TOKEN: '',
})

const parseContentResult = (output, phase) => {
  const matches = [...output.matchAll(/Processed (\d+) collections and (\d+) files in ([\d.]+)ms \((\d+) cached, (\d+) parsed\)/g)]
  const match = matches.at(-1)
  if (!match)
    throw new Error(`${phase} did not report Nuxt Content processing time.`)
  return {
    line: match[0],
    collections: Number(match[1]),
    files: Number(match[2]),
    durationMs: Number(match[3]),
    cachedFiles: Number(match[4]),
    parsedFiles: Number(match[5]),
  }
}

const walkFiles = async (root) => {
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory())
        await visit(path)
      else if (entry.isFile())
        files.push(path)
    }
  }
  await visit(root)
  return files
}

const directoryBytes = async (root) => {
  const files = await walkFiles(root)
  const sizes = await Promise.all(files.map(async path => (await stat(path)).size))
  return sizes.reduce((sum, size) => sum + size, 0)
}

const clientJavaScript = async (siteRoot, variant) => {
  const root = join(siteRoot, '.output/public')
  const files = (await walkFiles(root)).filter(path => path.endsWith('.js'))
  const markers = CONTENT_MARKERS[variant]
  let totalBytes = 0
  let totalGzipBytes = 0
  let contentBytes = 0
  let contentGzipBytes = 0
  const contentFiles = []
  for (const path of files) {
    const source = await readFile(path)
    const bytes = source.byteLength
    const gzipBytes = gzipSync(source, { level: 9 }).byteLength
    totalBytes += bytes
    totalGzipBytes += gzipBytes
    if (!markers.some(marker => source.includes(Buffer.from(marker))))
      continue
    contentBytes += bytes
    contentGzipBytes += gzipBytes
    contentFiles.push({
      path: relative(root, path),
      bytes,
      gzipBytes,
      sha256: createHash('sha256').update(source).digest('hex'),
    })
  }
  return { totalBytes, totalGzipBytes, contentBytes, contentGzipBytes, contentFiles }
}

const measureSsr = async (siteRoot, env, sample) => {
  const port = 19100 + sample
  const output = []
  const child = spawn('pnpm', [
    'exec',
    'wrangler',
    'dev',
    '--config',
    '.output/server/wrangler.json',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: siteRoot,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  const url = `http://127.0.0.1:${port}/experimental`
  try {
    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
      const response = await fetch(url).catch(() => undefined)
      if (response?.ok) {
        await response.arrayBuffer()
        ready = true
        break
      }
    }
    if (!ready)
      throw new Error(`SSR worker did not start.\n${stripAnsi(Buffer.concat(output).toString()).slice(-4000)}`)
    const startedAt = performance.now()
    const response = await fetch(url, { headers: { 'cache-control': 'no-store' } })
    const body = await response.arrayBuffer()
    const durationMs = performance.now() - startedAt
    if (!response.ok)
      throw new Error(`SSR request returned ${response.status}.`)
    return { durationMs, status: response.status, bytes: body.byteLength }
  }
  finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      }
      catch (error) {
        if (error.code !== 'ESRCH')
          throw error
      }
    }
    await new Promise(resolveExit => child.once('close', resolveExit))
  }
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

const metricPaths = [
  ['prepareMs'],
  ['productionBuildMs'],
  ['coldParseIndex', 'durationMs'],
  ['incrementalBuildMs'],
  ['incrementalParseIndex', 'durationMs'],
  ['ssr', 'durationMs'],
  ['sizes', 'clientJavaScript', 'totalBytes'],
  ['sizes', 'clientJavaScript', 'totalGzipBytes'],
  ['sizes', 'clientJavaScript', 'contentBytes'],
  ['sizes', 'clientJavaScript', 'contentGzipBytes'],
  ['sizes', 'nitroServerBytes'],
  ['sizes', 'installedDependencyBytes'],
]

const getPath = (value, path) => path.reduce((current, key) => current[key], value)

const medians = samples => Object.fromEntries(metricPaths.map(path => [path.join('.'), median(samples.map(sample => getPath(sample, path)))]))

const main = async () => {
  const { variant } = parseArgs(process.argv.slice(2))
  await assertEnvironment()
  await mkdir(RESULTS_ROOT, { recursive: true })
  const resultPath = join(RESULTS_ROOT, `${variant}.json`)
  const previous = await readFile(resultPath, 'utf8').then(JSON.parse).catch(() => undefined)
  const retainedSamples = previous?.status === 'running' && previous?.environment?.node === process.version && previous?.environment?.pnpm === PNPM_VERSION
    ? previous.samples ?? []
    : []
  const temporaryRoot = await mkdtemp(join(tmpdir(), `comark-content-${variant}-`))
  const siteRoot = join(temporaryRoot, 'site')
  const fontCacheRoot = join(temporaryRoot, 'font-cache')
  try {
    await cp(join(SITE_ROOT, 'node_modules/.cache/nuxt/fonts/meta'), fontCacheRoot, { recursive: true })
    process.stdout.write(`Copying ${SITE_ROOT}\n`)
    await cp(SITE_ROOT, siteRoot, { recursive: true, filter: shouldCopy })
    const packagePath = join(siteRoot, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
    if (variant === 'candidate') {
      await run('pnpm', ['pack', '--pack-destination', temporaryRoot], { cwd: PACKAGE_ROOT, env: process.env })
      const tarball = (await readdir(temporaryRoot)).find(file => file.endsWith('.tgz'))
      if (!tarball)
        throw new Error('Candidate package archive was not created.')
      packageJson.dependencies['@harlan-zw/comark-content'] = `file:${relative(siteRoot, join(temporaryRoot, tarball))}`
    }
    await writeFile(packagePath, `${JSON.stringify({ ...packageJson, packageManager: `pnpm@${PNPM_VERSION}` }, null, 2)}\n`)
    process.stdout.write('Installing pinned dependencies\n')
    await run('pnpm', ['install', variant === 'candidate' ? '--no-frozen-lockfile' : '--frozen-lockfile', '--prefer-offline'], {
      cwd: siteRoot,
      env: { ...process.env, CI: '1' },
    })
    const installedDependencyBytes = await directoryBytes(join(siteRoot, 'node_modules'))
    const sourcePath = join(siteRoot, 'content/blog/modern-package-development.md')
    const originalSource = await readFile(sourcePath, 'utf8')
    const samples = [...retainedSamples]
    for (let sample = samples.length + 1; sample <= SAMPLE_COUNT; sample++) {
      process.stdout.write(`[${sample}/${SAMPLE_COUNT}] isolated cold sample\n`)
      const sampleRoot = join(temporaryRoot, `sample-${sample}`)
      await resetBuildState(siteRoot, sampleRoot, fontCacheRoot)
      const env = benchmarkEnvironment(sampleRoot)
      const prepare = await run('pnpm', ['exec', 'nuxi', 'prepare'], { cwd: siteRoot, env })
      await resetBuildState(siteRoot, sampleRoot, fontCacheRoot)
      const productionBuild = await run('pnpm', ['exec', 'nuxi', 'build'], { cwd: siteRoot, env })
      const coldParseIndex = parseContentResult(productionBuild.output, 'Cold build')
      const sizes = {
        clientJavaScript: await clientJavaScript(siteRoot, variant),
        nitroServerBytes: await directoryBytes(join(siteRoot, '.output/server')),
        installedDependencyBytes,
      }
      const ssr = await measureSsr(siteRoot, env, sample)
      process.stdout.write(`[${sample}/${SAMPLE_COUNT}] one-file incremental sample\n`)
      await writeFile(sourcePath, `${originalSource}\n<!-- comark-content benchmark ${sample} -->\n`)
      let incrementalBuild
      try {
        incrementalBuild = await run('pnpm', ['exec', 'nuxi', 'build'], { cwd: siteRoot, env })
      }
      finally {
        await writeFile(sourcePath, originalSource)
      }
      const incrementalParseIndex = parseContentResult(incrementalBuild.output, 'Incremental build')
      samples.push({
        sample,
        prepareMs: prepare.durationMs,
        productionBuildMs: productionBuild.durationMs,
        coldParseIndex,
        incrementalBuildMs: incrementalBuild.durationMs,
        incrementalParseIndex,
        ssr,
        sizes,
      })
      await writeFile(resultPath, `${JSON.stringify({
        schemaVersion: 1,
        variant,
        status: 'running',
        createdAt: new Date().toISOString(),
        environment: { node: process.version, pnpm: PNPM_VERSION, samples: SAMPLE_COUNT },
        source: { root: SITE_ROOT, canary: 'harlanzw.com', incrementalFile: 'content/blog/modern-package-development.md' },
        classifier: { contentMarkers: CONTENT_MARKERS[variant] },
        samples,
      }, null, 2)}\n`)
    }
    const result = {
      schemaVersion: 1,
      variant,
      status: 'complete',
      createdAt: new Date().toISOString(),
      environment: { node: process.version, pnpm: PNPM_VERSION, samples: SAMPLE_COUNT },
      source: { root: SITE_ROOT, canary: 'harlanzw.com', incrementalFile: 'content/blog/modern-package-development.md' },
      classifier: { contentMarkers: CONTENT_MARKERS[variant] },
      samples,
      medians: medians(samples),
    }
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(result.medians, null, 2)}\n`)
  }
  finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
