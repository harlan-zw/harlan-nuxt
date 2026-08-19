import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const basicFixture = fileURLToPath(new URL('../fixtures/basic', import.meta.url))
const nuxtCli = fileURLToPath(new URL('bin/nuxt.mjs', import.meta.resolve('nuxt/package.json')))

describe('nuxt module integration', () => {
  it('generates field types, records one request, and stays within the Nitro bundle budget', async () => {
    await runNuxt(['prepare', 'tests/fixtures/basic'])
    await runFixtureTypecheck()
    await runNuxt(['build', 'tests/fixtures/basic'], { NUXT_WIDE_EVENTS_MEASURE: 'true' })

    const report = JSON.parse(await readFile(new URL('../fixtures/basic/.nuxt/dx/size-budget.json', import.meta.url), 'utf8'))
    const plugins = report.entries.filter((entry: BundleEntry) =>
      entry.scope === 'nitro' && entry.owner === '@harlan-zw/nuxt-wide-events',
    ) as BundleEntry[]
    const record = await requestBuiltFixture()

    expect(plugins).toHaveLength(1)
    expect(plugins[0]!.totalBytes).toBeGreaterThan(0)
    expect(plugins[0]!.totalBytes).toBeLessThanOrEqual(2 * 1024)
    expect(record.response).toEqual({ recorded: true })
    expect(record.logs).toEqual([
      expect.objectContaining({
        'kind': 'request',
        'level': 'info',
        'method': 'GET',
        'path': '/api/record',
        'service': 'integration-fixture',
        'status': 200,
        'cache.hit': true,
        'user.id': 'user_1',
      }),
      expect.objectContaining({
        level: 'error',
        method: 'GET',
        path: '/api/failure',
        status: 404,
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/created',
        status: 201,
      }),
    ])
    expect(record.missingStatus).toBe(404)
    expect(JSON.stringify(record.logs)).not.toContain('untrusted-request-id')
    expect(JSON.stringify(record.logs)).not.toContain('secret-error-message')
  }, 120_000)

  it('fails the Nuxt build when source uses an unconfigured field', async () => {
    const result = await runNuxt(['build', 'tests/fixtures/unsafe'])
      .then(() => ({ _tag: 'Ok' as const }), error => ({
        _tag: 'Err' as const,
        output: processOutput(error),
      }))

    expect(result).toEqual({
      _tag: 'Err',
      output: expect.stringContaining('server/api/record.get.ts:3 Field "password" is not configured in wideEvents.fields.'),
    })
  }, 60_000)

  it('excludes matching routes and keeps sampled errors by status', async () => {
    await runNuxt(['build', 'tests/fixtures/basic'], { NUXT_WIDE_EVENTS_POLICY: 'true' })

    expect(await requestPolicyFixture()).toEqual([
      expect.objectContaining({
        level: 'error',
        path: '/api/failure',
        status: 404,
      }),
    ])
  }, 60_000)

  it('keeps background collection and removes request collection when request is off', async () => {
    await runNuxt(['build', 'tests/fixtures/basic'], { NUXT_WIDE_EVENTS_STANDALONE: 'true' })

    const records = await requestStandaloneFixture()

    expect(records).toEqual([
      expect.objectContaining({
        'kind': 'background',
        'level': 'warn',
        'service': 'integration-fixture',
        'user.id': 'standalone_1',
      }),
      expect.objectContaining({
        'kind': 'background',
        'level': 'warn',
        'service': 'integration-fixture',
        'user.id': 'deep_1',
      }),
    ])
    expect(records.every(record => record.method === undefined && record.status === undefined)).toBe(true)
  }, 60_000)

  it('keeps every server import and stops output when the module is disabled', async () => {
    await runNuxt(['build', 'tests/fixtures/basic'], { NUXT_WIDE_EVENTS_DISABLED: 'true' })

    expect(await requestDisabledFixture()).toEqual({ logs: [], response: { recorded: true } })
  }, 60_000)

  it('drains request and background Wide Events through one hook', async () => {
    await runNuxt(['build', 'tests/fixtures/basic'], { NUXT_WIDE_EVENTS_DRAIN: 'true' })

    const result = await requestDrainFixture()

    expect(result.standaloneStatus).toBe(500)
    expect(result.d1).toEqual([
      expect.objectContaining({ 'kind': 'request', 'path': '/api/record', 'user.id': 'user_1' }),
      expect.objectContaining({ 'kind': 'background', 'user.id': 'standalone_1' }),
      expect.objectContaining({ kind: 'request', level: 'error', path: '/api/standalone', status: 500 }),
    ])
    expect(result.sentry).toEqual(result.d1)
  }, 60_000)

  it('validates imported graph modules with a custom server directory', async () => {
    const fixture = await createGraphFixture()
    try {
      const result = await runNuxt(['build', fixture])
        .then(() => ({ _tag: 'Ok' as const }), error => ({
          _tag: 'Err' as const,
          output: processOutput(error),
        }))

      expect(result).toEqual({
        _tag: 'Err',
        output: expect.stringContaining('workspace/record.ts:2 Field "password" is not configured in wideEvents.fields.'),
      })
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 60_000)
})

interface BundleEntry {
  owner?: string
  scope: string
  totalBytes: number
}

function runNuxt(arguments_: string[], environment: Record<string, string> = {}) {
  return execFileAsync(process.execPath, [nuxtCli, ...arguments_], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...environment,
      NO_COLOR: '1',
      PATH: `${join(packageRoot, 'node_modules/.bin')}${delimiter}${process.env.PATH}`,
    },
    maxBuffer: 20 * 1024 * 1024,
  })
}

function runFixtureTypecheck() {
  return execFileAsync(join(packageRoot, 'node_modules/.bin/vue-tsc'), [
    '--noEmit',
    '-p',
    'tests/fixtures/basic/tsconfig.json',
  ], {
    cwd: packageRoot,
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 20 * 1024 * 1024,
  })
}

function processOutput(error: unknown): string {
  const output = error as { stderr?: string, stdout?: string }
  return `${output.stdout ?? ''}\n${output.stderr ?? ''}`
}

async function requestBuiltFixture(): Promise<{ logs: Record<string, unknown>[], missingStatus: number, response: unknown }> {
  const port = await availablePort()
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: basicFixture,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      NO_COLOR: '1',
      PORT: String(port),
    },
    stdio: 'pipe',
  })
  let output = ''
  child.stdout.on('data', chunk => output += String(chunk))
  child.stderr.on('data', chunk => output += String(chunk))

  return runRequest(child, port, () => output)
    .finally(() => child.kill('SIGTERM'))
}

async function requestPolicyFixture(): Promise<Record<string, unknown>[]> {
  const port = await availablePort()
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: basicFixture,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      NO_COLOR: '1',
      PORT: String(port),
    },
    stdio: 'pipe',
  })
  let output = ''
  child.stdout.on('data', chunk => output += String(chunk))
  child.stderr.on('data', chunk => output += String(chunk))

  try {
    await waitForServer(child, port, () => output)
    await fetch(`http://127.0.0.1:${port}/api/record`)
    await fetch(`http://127.0.0.1:${port}/api/excluded/ping?token=secret`)
    await fetch(`http://127.0.0.1:${port}/api/failure`)
    await waitFor(() => eventLogs(output).length === 1, child, () => output)
    return eventLogs(output)
  }
  finally {
    child.kill('SIGTERM')
  }
}

async function requestStandaloneFixture(): Promise<Record<string, unknown>[]> {
  const port = await availablePort()
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: basicFixture,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      NO_COLOR: '1',
      PORT: String(port),
    },
    stdio: 'pipe',
  })
  let output = ''
  child.stdout.on('data', chunk => output += String(chunk))
  child.stderr.on('data', chunk => output += String(chunk))

  try {
    await waitForServer(child, port, () => output)
    output = ''
    await fetch(`http://127.0.0.1:${port}/api/standalone`)
    await fetch(`http://127.0.0.1:${port}/api/deep-standalone`)
    await waitFor(() => eventLogs(output).length === 2, child, () => output)
    return eventLogs(output)
  }
  finally {
    child.kill('SIGTERM')
  }
}

async function requestDisabledFixture(): Promise<{ logs: Record<string, unknown>[], response: unknown }> {
  const port = await availablePort()
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: basicFixture,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      NO_COLOR: '1',
      PORT: String(port),
    },
    stdio: 'pipe',
  })
  let output = ''
  child.stdout.on('data', chunk => output += String(chunk))
  child.stderr.on('data', chunk => output += String(chunk))

  try {
    await waitForServer(child, port, () => output)
    output = ''
    const response = await fetch(`http://127.0.0.1:${port}/api/record`).then(value => value.json())
    await fetch(`http://127.0.0.1:${port}/api/standalone`)
    await new Promise(resolve => setTimeout(resolve, 250))
    return { logs: eventLogs(output), response }
  }
  finally {
    child.kill('SIGTERM')
  }
}

async function requestDrainFixture(): Promise<{
  d1: Record<string, unknown>[]
  sentry: Record<string, unknown>[]
  standaloneStatus: number
}> {
  const port = await availablePort()
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: basicFixture,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      NO_COLOR: '1',
      PORT: String(port),
    },
    stdio: 'pipe',
  })
  let output = ''
  child.stdout.on('data', chunk => output += String(chunk))
  child.stderr.on('data', chunk => output += String(chunk))

  try {
    await waitForServer(child, port, () => output)
    await fetch(`http://127.0.0.1:${port}/api/record`)
    const standaloneStatus = await fetch(`http://127.0.0.1:${port}/api/standalone`).then(response => response.status)
    await waitFor(() => drainLogs(output, 'Sentry').length === 3, child, () => output)
    return {
      d1: drainLogs(output, 'D1'),
      sentry: drainLogs(output, 'Sentry'),
      standaloneStatus,
    }
  }
  finally {
    child.kill('SIGTERM')
  }
}

async function runRequest(
  child: ChildProcessWithoutNullStreams,
  port: number,
  output: () => string,
): Promise<{ logs: Record<string, unknown>[], missingStatus: number, response: unknown }> {
  await waitForServer(child, port, output)
  const response = await fetch(`http://127.0.0.1:${port}/api/record`, {
    headers: { 'x-request-id': 'untrusted-request-id' },
  }).then(value => value.json())
  const missingStatus = await fetch(`http://127.0.0.1:${port}/api/failure`)
    .then(value => value.status)
  await fetch(`http://127.0.0.1:${port}/api/created`, { method: 'POST' })
  await waitFor(() => eventLogs(output()).length === 3, child, output)
  return { logs: eventLogs(output()), missingStatus, response }
}

function eventLogs(output: string): Record<string, unknown>[] {
  return output
    .split(/\r?\n/)
    .filter(line => line.startsWith('{') && line.includes('"requestId"'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function drainLogs(output: string, adapter: 'D1' | 'Sentry'): Record<string, unknown>[] {
  const prefix = `${adapter} Wide Event `
  return output
    .split(/\r?\n/)
    .filter(line => line.startsWith(prefix))
    .map(line => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>)
}

async function waitForServer(child: ChildProcessWithoutNullStreams, port: number, output: () => string): Promise<void> {
  await waitFor(() => canConnect(port), child, output)
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition())
      return
    if (child.exitCode !== null)
      throw new Error(`Nitro exited with ${child.exitCode}.\n${output()}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Nitro did not become ready.\n${output()}`)
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(100)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local port.'))
        return
      }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

async function createGraphFixture(): Promise<string> {
  const fixture = await mkdtemp(join(packageRoot, 'tests/.graph-fixture-'))
  await mkdir(join(fixture, 'backend/api'), { recursive: true })
  await mkdir(join(fixture, 'workspace'), { recursive: true })
  await writeFile(join(fixture, 'nuxt.config.ts'), `
import wideEvents from '../../src/module'

export default defineNuxtConfig({
  modules: [wideEvents],
  serverDir: 'backend',
  wideEvents: { fields: ['user.id'] },
})
`)
  await writeFile(join(fixture, 'backend/api/record.get.ts'), `
import { recordRequest } from '../../workspace/record'

export default defineEventHandler(event => recordRequest(event))
`)
  await writeFile(join(fixture, 'workspace/record.ts'), `export function recordRequest(event: unknown) {
  addWideEventFields(event, { password: 'secret' })
  return { recorded: true }
}
`)
  return fixture
}
