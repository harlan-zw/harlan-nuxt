import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

const NODE_VERSION = 'v24.17.0'
const PNPM_VERSION = '11.2.1'
const SAMPLE_COUNT = 10
const SITE_REPOSITORY = '/home/harlan/sites/harlanzw.com'
const SITE_REVISIONS = {
  baseline: '467359fe698bda36bbd238bf664f078e49f294a1',
  candidate: '467359fe698bda36bbd238bf664f078e49f294a1',
}
const ROUTE = '/blog/modern-package-development/'
const PACKAGE_ROOT = resolve(import.meta.dirname, '../..')
const RESULTS_ROOT = resolve(import.meta.dirname, 'results')
const BROWSER_SAMPLE_PATH = resolve(import.meta.dirname, 'browser-sample.js')
const RESULT_MARKER = '__COMARK_SITE_BENCHMARK__'

const parseArgs = (args) => {
  const variantIndex = args.indexOf('--variant')
  const variant = variantIndex === -1 ? 'both' : args[variantIndex + 1]
  if (!['baseline', 'candidate', 'both'].includes(variant))
    throw new Error('Expected --variant baseline, candidate, or both.')
  const sampleIndex = args.indexOf('--samples')
  const samples = sampleIndex === -1 ? SAMPLE_COUNT : Number(args[sampleIndex + 1])
  if (!Number.isInteger(samples) || samples < 1 || samples > SAMPLE_COUNT)
    throw new Error(`Expected --samples between 1 and ${SAMPLE_COUNT}.`)
  return { samples, variants: variant === 'both' ? ['baseline', 'candidate'] : [variant] }
}

const stripAnsi = value => value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')

const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
  const startedAt = performance.now()
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: options.detached,
    env: options.env,
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  if (options.input !== undefined)
    child.stdin.end(options.input)
  child.on('error', reject)
  child.on('close', (code) => {
    const result = { code, durationMs: performance.now() - startedAt, output: stripAnsi(output) }
    if (code === 0 || options.allowFailure) {
      resolveRun(result)
      return
    }
    reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.\n${result.output.slice(-30000)}`))
  })
})

const commandOutput = async (command, args, cwd) => (await run(command, args, { cwd, env: process.env })).output.trim()

const assertEnvironment = async () => {
  if (process.version !== NODE_VERSION)
    throw new Error(`Expected Node ${NODE_VERSION}, received ${process.version}.`)
  const pnpmVersion = await commandOutput('pnpm', ['--version'], process.cwd())
  if (pnpmVersion !== PNPM_VERSION)
    throw new Error(`Expected pnpm ${PNPM_VERSION}, received ${pnpmVersion}.`)
  await commandOutput('dev-browser', ['--help'], process.cwd())
}

const extractRevision = async (revision, destination) => {
  await mkdir(destination, { recursive: true })
  await new Promise((resolveExtract, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', revision], { cwd: SITE_REPOSITORY, stdio: ['ignore', 'pipe', 'pipe'] })
    const extract = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'pipe', 'pipe'] })
    let errors = ''
    archive.stderr.on('data', chunk => errors += chunk)
    extract.stderr.on('data', chunk => errors += chunk)
    archive.stdout.pipe(extract.stdin)
    archive.on('error', reject)
    extract.on('error', reject)
    extract.on('close', (code) => code === 0 ? resolveExtract() : reject(new Error(`Could not extract ${revision}.\n${errors}`)))
  })
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

const directoryBytes = async root => (await Promise.all((await walkFiles(root)).map(async path => (await stat(path)).size))).reduce((sum, size) => sum + size, 0)

const packageFingerprint = async () => {
  const paths = [join(PACKAGE_ROOT, 'package.json'), ...await walkFiles(join(PACKAGE_ROOT, 'src'))].sort()
  const hash = createHash('sha256')
  for (const path of paths)
    hash.update(relative(PACKAGE_ROOT, path)).update('\0').update(await readFile(path)).update('\0')
  return hash.digest('hex')
}

const prepareCandidate = async (siteRoot, temporaryRoot) => {
  const packed = await run('pnpm', ['pack', '--pack-destination', temporaryRoot], { cwd: PACKAGE_ROOT, env: process.env })
  const tarball = (await readdir(temporaryRoot)).find(file => file.endsWith('.tgz'))
  if (!tarball)
    throw new Error(`Candidate package archive was not created.\n${packed.output.slice(-4000)}`)
  const packagePath = join(siteRoot, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  packageJson.devDependencies['@harlan-zw/comark-content'] = `file:${relative(siteRoot, join(temporaryRoot, tarball))}`
  delete packageJson.devDependencies.shiki
  packageJson.packageManager = `pnpm@${PNPM_VERSION}`
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  const configPath = join(siteRoot, 'nuxt.config.ts')
  const config = await readFile(configPath, 'utf8')
  if (!config.includes("'@harlan-zw/comark-content'"))
    throw new Error('Candidate revision does not use comark-content.')
  if (!config.includes('content: {'))
    await writeFile(configPath, config.replace("\n  css: ['~/assets/css/main.css'],", "\n  content: { highlight: true },\n\n  css: ['~/assets/css/main.css'],"))
}

const prepareBaseline = async (siteRoot) => {
  const packagePath = join(siteRoot, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  delete packageJson.devDependencies['@harlan-zw/comark-content']
  delete packageJson.devDependencies.shiki
  packageJson.devDependencies['@nuxt/content'] = '3.15.2'
  packageJson.devDependencies['better-sqlite3'] = '12.11.1'
  packageJson.packageManager = `pnpm@${PNPM_VERSION}`
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

  const workspacePath = join(siteRoot, 'pnpm-workspace.yaml')
  const workspace = await readFile(workspacePath, 'utf8')
  await writeFile(workspacePath, workspace.replace("allowBuilds:\n", "allowBuilds:\n  better-sqlite3: true\n"))

  const configPath = join(siteRoot, 'nuxt.config.ts')
  const config = (await readFile(configPath, 'utf8'))
    .replace("'@harlan-zw/comark-content',", "'@nuxt/content',")
    .replace('failOnError: true', 'failOnError: false')
    .replace(
      "  content: {\n    highlight: true,\n  },",
      `  content: {
    database: {
      type: 'd1',
      bindingName: 'DB',
    },
    build: {
      markdown: {
        highlight: {
          theme: {
            default: {
              name: 'harlanzw-light-high-contrast',
              type: 'light',
              fg: '#0e1116',
              bg: '#fff',
              settings: [
                { settings: { foreground: '#0e1116', background: '#fff' } },
              ],
            },
            light: 'github-light-high-contrast',
            dark: 'github-dark-high-contrast',
          },
        },
      },
    },
  },`,
    )
  await writeFile(configPath, config)

  const contentConfigPath = join(siteRoot, 'content.config.ts')
  await writeFile(contentConfigPath, (await readFile(contentConfigPath, 'utf8')).replace("'@harlan-zw/comark-content'", "'@nuxt/content'"))

  const contentUtilityPath = join(siteRoot, 'app/utils/content.ts')
  await writeFile(contentUtilityPath, (await readFile(contentUtilityPath, 'utf8'))
    .replace("'@harlan-zw/comark-content'", "'@nuxt/content'")
    .replace('body.nodes.flatMap', 'body.value.flatMap'))

  const rssPath = join(siteRoot, 'server/utils/rss.ts')
  await writeFile(rssPath, (await readFile(rssPath, 'utf8')).replace("'@harlan-zw/comark-content/server'", "'@nuxt/content/server'"))

  const typesPath = join(siteRoot, 'shared/types.ts')
  await writeFile(typesPath, (await readFile(typesPath, 'utf8'))
    .replace("import type { PageCollectionItemBase } from '@harlan-zw/comark-content'", "import type { PagesCollectionItem } from '@nuxt/content'")
    .replace('export interface SitePage extends PageCollectionItemBase', 'export interface SitePage extends PagesCollectionItem'))

  const historicalContentPage = await commandOutput('git', ['show', '403cdca^:app/utils/content-page.ts'], SITE_REPOSITORY)
  await writeFile(join(siteRoot, 'app/utils/content-page.ts'), `${historicalContentPage}\n`)

  const pagePath = join(siteRoot, 'app/pages/[...all].vue')
  await writeFile(pagePath, (await readFile(pagePath, 'utf8'))
    .replaceAll('ContentPostMeta', 'PostMeta')
    .replaceAll('ContentProse', 'Prose'))
}

const startWorker = async (siteRoot, port, env) => {
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
  ], { cwd: siteRoot, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  const url = `http://127.0.0.1:${port}${ROUTE}`
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok) {
      await response.arrayBuffer()
      return { child, output, url }
    }
  }
  if (child.pid)
    process.kill(-child.pid, 'SIGTERM')
  throw new Error(`Worker did not start.\n${stripAnsi(Buffer.concat(output).toString()).slice(-4000)}`)
}

const stopWorker = async (worker) => {
  if (!worker.child.pid)
    return
  try {
    process.kill(-worker.child.pid, 'SIGTERM')
  }
  catch (error) {
    if (error.code !== 'ESRCH')
      throw error
  }
  await Promise.race([
    new Promise(resolveExit => worker.child.once('close', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5000)),
  ])
}

const startChrome = async (profileRoot, port) => {
  const child = spawn('/usr/bin/google-chrome', [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-sandbox',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileRoot}`,
    'about:blank',
  ], { detached: true, env: process.env, stdio: ['ignore', 'ignore', 'ignore'] })
  const endpoint = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const response = await fetch(`${endpoint}/json/version`).catch(() => undefined)
    if (response?.ok)
      return { child, endpoint }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  if (child.pid)
    process.kill(-child.pid, 'SIGTERM')
  throw new Error('Benchmark Chrome did not start.')
}

const stopChrome = async (chrome) => {
  if (!chrome.child.pid)
    return
  try {
    process.kill(-chrome.child.pid, 'SIGTERM')
  }
  catch (error) {
    if (error.code !== 'ESRCH')
      throw error
  }
  await Promise.race([
    new Promise(resolveExit => chrome.child.once('close', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5000)),
  ])
}

const browserSample = async ({ sample, temporaryRoot, url, variant }) => {
  const source = (await readFile(BROWSER_SAMPLE_PATH, 'utf8'))
    .replace('__TARGET_URL__', url)
    .replace('__VARIANT__', variant)
    .replace('__SAMPLE__', String(sample))
  const port = (variant === 'baseline' ? 19800 : 19900) + sample
  const chrome = await startChrome(join(temporaryRoot, `browser-${sample}`), port)
  try {
    const browserRun = await run('dev-browser', [
      '--connect',
      chrome.endpoint,
      '--timeout',
      '120',
    ], { cwd: PACKAGE_ROOT, env: process.env, input: source })
    const marker = browserRun.output.lastIndexOf(RESULT_MARKER)
    if (marker === -1)
      throw new Error(`Browser sample did not return metrics.\n${browserRun.output.slice(-4000)}`)
    const result = JSON.parse(browserRun.output.slice(marker + RESULT_MARKER.length).trim())
    const hydrationErrors = result.consoleErrors.filter(message => /hydration|resolve component/i.test(message))
    if (result.status !== 200
      || result.assertions.heading !== 1
      || result.assertions.prose !== 1
      || result.assertions.rawContentTags !== 0
      || result.pageErrors.length
      || hydrationErrors.length
      || !result.metrics.lcp) {
      throw new Error(`Browser parity failed.\n${JSON.stringify(result, null, 2)}`)
    }
    return result
  }
  finally {
    await stopChrome(chrome)
  }
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const metricPaths = [
  ['metrics', 'cls'],
  ['metrics', 'domContentLoadedMs'],
  ['metrics', 'fcpMs'],
  ['metrics', 'interaction', 'durationMs'],
  ['metrics', 'lcp', 'startTimeMs'],
  ['metrics', 'loadMs'],
  ['metrics', 'requests'],
  ['metrics', 'resourceDecodedBytes'],
  ['metrics', 'resourceTransferBytes'],
  ['metrics', 'ttfbMs'],
]

const getPath = (value, path) => path.reduce((current, key) => current?.[key], value)
const medians = samples => Object.fromEntries(metricPaths.map(path => [path.join('.'), median(samples.map(sample => getPath(sample, path)).filter(value => typeof value === 'number'))]))

const benchmarkVariant = async (variant, requestedSamples) => {
  const revision = SITE_REVISIONS[variant]
  const temporaryRoot = await mkdtemp(join(tmpdir(), `comark-site-harlanzw-${variant}-`))
  const siteRoot = join(temporaryRoot, 'site')
  const resultPath = join(RESULTS_ROOT, `${variant}.json`)
  const fingerprint = variant === 'candidate' ? await packageFingerprint() : undefined
  const previous = await readFile(resultPath, 'utf8').then(JSON.parse).catch(() => undefined)
  const retainedSamples = previous?.status === 'running'
    && previous?.source?.revision === revision
    && previous?.packageFingerprint === fingerprint
    ? previous.samples ?? []
    : []
  let worker
  try {
    process.stdout.write(`[${variant}] extracting ${revision}\n`)
    await extractRevision(revision, siteRoot)
    if (variant === 'candidate')
      await prepareCandidate(siteRoot, temporaryRoot)
    else
      await prepareBaseline(siteRoot)
    process.stdout.write(`[${variant}] installing dependencies\n`)
    await run('pnpm', ['install', '--no-frozen-lockfile', '--prefer-offline'], { cwd: siteRoot, env: { ...process.env, CI: '1' } })
    process.stdout.write(`[${variant}] building production site\n`)
    const env = { ...process.env, CI: '1', NUXT_TELEMETRY_DISABLED: '1', SENTRY_AUTH_TOKEN: '' }
    const build = await run('pnpm', ['exec', 'nuxi', 'build'], { cwd: siteRoot, env })
    const sizes = {
      clientJavaScriptBytes: await directoryBytes(join(siteRoot, '.output/public/_nuxt')),
      nitroServerBytes: await directoryBytes(join(siteRoot, '.output/server')),
    }
    const port = variant === 'baseline' ? 19710 : 19711
    worker = await startWorker(siteRoot, port, env)
    const samples = retainedSamples.slice(0, requestedSamples)
    for (let sample = samples.length + 1; sample <= requestedSamples; sample++) {
      process.stdout.write(`[${variant}] browser sample ${sample}/${requestedSamples}\n`)
      samples.push(await browserSample({ sample, temporaryRoot, url: worker.url, variant }))
      await writeFile(resultPath, `${JSON.stringify({
        schemaVersion: 1,
        variant,
        status: 'running',
        createdAt: new Date().toISOString(),
        environment: {
          browser: 'dev-browser Chromium',
          cpuThrottle: 4,
          downloadBytesPerSecond: 4000000,
          latencyMs: 40,
          node: process.version,
          pnpm: PNPM_VERSION,
          samples: requestedSamples,
          uploadBytesPerSecond: 1000000,
          viewport: { height: 844, width: 390 },
        },
        source: { repository: SITE_REPOSITORY, revision, route: ROUTE },
        packageFingerprint: fingerprint,
        build: { durationMs: build.durationMs, sizes },
        samples,
      }, null, 2)}\n`)
    }
    const result = {
      schemaVersion: 1,
      variant,
      status: requestedSamples === SAMPLE_COUNT ? 'complete' : 'smoke',
      createdAt: new Date().toISOString(),
      environment: {
        browser: 'dev-browser Chromium',
        cpuThrottle: 4,
        downloadBytesPerSecond: 4000000,
        latencyMs: 40,
        node: process.version,
        pnpm: PNPM_VERSION,
        samples: requestedSamples,
        uploadBytesPerSecond: 1000000,
        viewport: { height: 844, width: 390 },
      },
      source: { repository: SITE_REPOSITORY, revision, route: ROUTE },
      packageFingerprint: fingerprint,
      build: { durationMs: build.durationMs, sizes },
      samples,
      medians: medians(samples),
    }
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    const screenshot = samples.find(sample => sample.screenshot)?.screenshot
    if (screenshot)
      await cp(screenshot, join(RESULTS_ROOT, `${variant}.png`))
    process.stdout.write(`${variant}: ${JSON.stringify(result.medians)}\n`)
  }
  finally {
    if (worker)
      await stopWorker(worker)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

const main = async () => {
  const { samples, variants } = parseArgs(process.argv.slice(2))
  await assertEnvironment()
  await mkdir(RESULTS_ROOT, { recursive: true })
  for (const variant of variants)
    await benchmarkVariant(variant, samples)
}

await main()
