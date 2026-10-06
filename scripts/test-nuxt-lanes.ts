import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { parse, stringify } from 'yaml'

const NIGHTLY = '5.0.0-2610052343-36eafab'
const lane = process.argv[2] ?? 'minimum'
assert(['minimum', 'future', 'nightly'].includes(lane), `Unknown Nuxt lane: ${lane}`)
const root = resolve(import.meta.dirname, '..')
const fixture = await mkdtemp(resolve(tmpdir(), `harlan-nuxt-${lane}-`))
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const policy = parse(await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8'))
const modules: string[] = []
const dependencies: Record<string, string> = {}
await mkdir(resolve(fixture, 'tarballs'))

function run(args: string[], cwd = fixture) {
  execFileSync('pnpm', args, { cwd, stdio: 'inherit', env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } })
}

for (const directory of await readdir(resolve(root, 'packages'))) {
  const cwd = resolve(root, 'packages', directory)
  const pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'))
  const archive = `${directory}.tgz`
  // CI builds once before this command. Packing must not clean another check's artifacts.
  run(['pack', '--config.ignore-scripts=true', '--out', resolve(fixture, 'tarballs', archive)], cwd)
  dependencies[pkg.name] = `file:./tarballs/${archive}`
  if (pkg.peerDependencies?.nuxt)
    modules.push(pkg.name)
}

await cp(resolve(root, 'test/nuxt-migration'), fixture, { recursive: true, filter: path => !path.includes('/locks') })
const lockPath = resolve(root, 'test/nuxt-migration/locks', `${lane === 'nightly' ? 'nightly' : 'stable'}.yaml`)
const updateLock = process.env.NUXT_UPDATE_LOCKS === '1'
let lockedPackages: Record<string, unknown> | undefined
if (!updateLock) {
  const lock = await readFile(lockPath, 'utf8')
  lockedPackages = parse(lock).packages
  const seed = parse(lock)
  // Rebuilt local archives get new integrity hashes. Keep their resolved dependency snapshots.
  for (const entry of Object.values(seed.packages) as { resolution: { integrity: string, tarball?: string } }[]) {
    if (entry.resolution.tarball?.startsWith('file:')) {
      const archive = await readFile(resolve(fixture, entry.resolution.tarball.slice(5)))
      entry.resolution.integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    }
  }
  await writeFile(resolve(fixture, 'pnpm-lock.yaml'), stringify(seed))
}
const nuxt = lane === 'nightly' ? `npm:nuxt-nightly@${NIGHTLY}` : '4.6.0'
await writeFile(resolve(fixture, 'package.json'), JSON.stringify({
  private: true,
  type: 'module',
  // The pinned nightly stalls with pnpm 11.2. Stable lanes use the repository's pin.
  packageManager: lane === 'nightly' ? 'pnpm@11.22.0' : manifest.packageManager,
  dependencies: { ...dependencies, nuxt, 'vue': '3.5.43', 'vue-router': '5.3.1', 'zod': '4.4.3', 'typescript': '5.9.3', 'vue-tsc': '3.3.9' },
}, null, 2))
// Keep the producer's supply-chain policy and build approvals in the isolated consumer.
delete policy.packages
delete policy.catalog
policy.overrides = { ...dependencies, nuxt }
if (lane === 'nightly') {
  // This pinned Kit requires ^1.9.0. Nuxt's matching workspace approves that exact release too.
  policy.minimumReleaseAgeExclude = [...(policy.minimumReleaseAgeExclude ?? []), 'package-manager-detector@1.9.0', ...['nuxt', '@nuxt/kit', '@nuxt/schema', '@nuxt/vite-builder', '@nuxt/nitro-server', '@nuxt/vite-server'].map(name => `${name}-nightly@${NIGHTLY}`)]
}
await writeFile(resolve(fixture, 'pnpm-workspace.yaml'), stringify(policy))
await mkdir(resolve(fixture, 'server/plugins'), { recursive: true })
await writeFile(resolve(fixture, 'server/plugins/drains.ts'), `
${lane === 'nightly' ? 'import { definePlugin as defineNitroPlugin } from \'nitro\'\nimport { useNitroHooks } from \'nitro/app\'' : 'import { defineNitroPlugin, useNitroApp } from \'nitropack/runtime\''}
import { drainEvidence } from '../utils/drain-evidence'
import { telemetryEvidence } from '../utils/telemetry-evidence'
import type { FetchSummaryTelemetryEvent } from '@harlan-zw/nuxt-use-query/telemetry'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from '@harlan-zw/nuxt-use-query/telemetry'
export default defineNitroPlugin(() => {
  const hooks = ${lane === 'nightly' ? 'useNitroHooks()' : 'useNitroApp().hooks'}
  hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSummary, (record: FetchSummaryTelemetryEvent) => { telemetryEvidence.push(record) })
  hooks.hook('wide-events:emit', (record) => {
    if (record.kind !== 'background') return
    drainEvidence.push('failed')
    throw new Error('migration-sink-failed')
  })
  hooks.hook('wide-events:emit', (record) => {
    if (record.kind === 'background') drainEvidence.push('healthy')
  })
})
`)
await writeFile(resolve(fixture, 'nuxt.config.ts'), `
import { defineNuxtConfig } from 'nuxt/config'
${modules.map((name, index) => `import module${index} from '${name}'`).join('\n')}
const modules = [${modules.map((_, index) => `module${index}`).join(', ')}]
${lane === 'nightly' ? `for (const module of modules) { const meta = await module.getMeta(); meta.compatibility = { ...meta.compatibility, nuxt: '^4.6.0 || ^5.0.0 || ${NIGHTLY}' } }` : ''}
export default defineNuxtConfig({
  modules,
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  ${lane === 'future' ? 'future: { compatibilityVersion: 5 },' : ''}
  ${lane === 'nightly' ? '' : 'experimental: { routeTypedFetch: true },'}
  githubSponsors: { login: 'harlan-zw', mode: 'runtime', tokenEnv: 'MIGRATION_SPONSORS_TOKEN' },
  wideEvents: { console: true, drain: true },
  nuxtUseQuery: { telemetry: true },
  content: { highlight: false },
  runtimeConfig: { htmlCacheCapabilities: [{ v: 1, by: 'migration-fixture', documentTtlCeilingSeconds: 600, basis: 'retention-days', assetRecovery: true }] },
  routeRules: { '/cached': { headers: { 'cache-control': 'public, s-maxage=300' } }, '/too-long': { headers: { 'cache-control': 'public, s-maxage=3600' } } },
  nitro: { preset: 'node-server', cloudflare: { wrangler: Object.assign({ name: 'migration-fixture' }, { cache: { enabled: true } }) } },
})
`)
let output = ''
let completed = false
let server: ReturnType<typeof spawn> | undefined
try {
  // Local archive contents change with each build. Registry packages remain locked.
  run(['install', updateLock ? '--no-frozen-lockfile' : '--frozen-lockfile', '--ignore-scripts', '--reporter=append-only'])
  const installedLock = await readFile(resolve(fixture, 'pnpm-lock.yaml'), 'utf8')
  if (lockedPackages) {
    const registryPackages = (packages: Record<string, unknown>) => Object.fromEntries(Object.entries(packages).filter(([name]) => !name.includes('file:')))
    assert.deepEqual(registryPackages(parse(installedLock).packages), registryPackages(lockedPackages), 'Registry dependencies changed. Refresh the lane lock explicitly.')
  }
  // The configuration loader also exercises ESM exports through Jiti.
  run(['exec', 'node', '--input-type=commonjs', '-e', `for (const name of ${JSON.stringify(modules)}) require(name)`])
  run(['exec', 'nuxt', 'prepare'])
  run(['exec', 'nuxt', 'typecheck'])
  run(['exec', 'nuxt', 'build'])
  const socket = createServer()
  await new Promise<void>(done => socket.listen(0, '127.0.0.1', done))
  const address = socket.address()
  assert(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((done, fail) => socket.close(error => error ? fail(error) : done()))
  server = spawn(process.execPath, [resolve(fixture, '.output/server/index.mjs')], {
    cwd: fixture,
    env: { ...process.env, PORT: String(port), NITRO_PORT: String(port), HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (chunk) => {
    output += String(chunk)
  })
  server.stderr?.on('data', (chunk) => {
    output += String(chunk)
  })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  let lastError: unknown
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${base}/api/query`).catch((error: unknown) => {
      lastError = error
      return undefined
    })
    if (response?.ok) {
      ready = true
      break
    }
    if (server.exitCode !== null)
      break
    await setTimeout(250)
  }
  assert(ready, `Consumer did not start: ${String(lastError)}\n${output}`)
  const html = await (await fetch(base)).text()
  assert(html.includes('migration-query:42:7:false'), html)
  const fetchBody = await (await fetch(`${base}/api/fetch-body`)).json()
  assert.deepEqual(fetchBody, { value: 17 })
  const telemetry = await (await fetch(`${base}/api/telemetry`)).json()
  assert(telemetry.some((record: { request: string, fetches: number }) => record.request === 'GET /' && record.fetches >= 1), JSON.stringify(telemetry))
  if (lane === 'nightly')
    assert(telemetry.some((record: { request: string, fetches: number }) => record.request === 'GET /api/fetch-body' && record.fetches === 1), JSON.stringify(telemetry))
  const sponsors = await (await fetch(`${base}/api/github-sponsors`)).json()
  assert.equal(sponsors.reason, 'not-configured')
  const checks = await (await fetch(`${base}/api/checks`)).json()
  assert.deepEqual(checks.results.find((check: { id: string }) => check.id === 'migration.runtime')?.result, { _tag: 'Pass', evidence: { value: 42 } })
  const content = await (await fetch(`${base}/__comark_content/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _tag: 'Query', collection: 'docs', plan: { operations: [{ _tag: 'Path', value: '/guide' }] } }),
  })).json()
  assert.equal(content[0]?.title, 'Migration fixture')
  const cached = await fetch(`${base}/cached`)
  assert.equal(cached.headers.get('cache-control'), 'public, s-maxage=300')
  const clamped = await fetch(`${base}/too-long`)
  assert.equal(clamped.headers.get('cache-control'), 'public, s-maxage=600')
  const credentialed = await fetch(`${base}/cached`, { headers: { authorization: 'Bearer migration' } })
  assert.equal(credentialed.headers.get('cache-control'), 'private, no-store')
  const drains = await (await fetch(`${base}/api/drains`)).json()
  assert.deepEqual(drains, { error: 'migration-sink-failed', delivered: ['failed', 'healthy'] })
  await setTimeout(50)
  assert(output.includes('"kind":"request"'), `Wide Events emitted no request: ${output}`)
  assert(output.includes('"path":"/cached"'), `Wide Events lost the native request path: ${output}`)
  completed = true
  if (updateLock) {
    await mkdir(resolve(root, 'test/nuxt-migration/locks'), { recursive: true })
    await writeFile(lockPath, installedLock)
  }
  console.log(`Passed ${lane}: packed modules, ESM loaders, Query SSR, content, checks, sponsors, cache headers.`)
}
catch (error) {
  console.error(`Consumer evidence: ${fixture}\n${output}`)
  throw error
}
finally {
  server?.kill('SIGTERM')
  if (process.env.NUXT_KEEP_FIXTURE !== '1' && completed)
    await rm(fixture, { recursive: true, force: true })
}
