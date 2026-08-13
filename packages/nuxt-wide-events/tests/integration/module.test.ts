import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const basicFixture = fileURLToPath(new URL('../fixtures/basic', import.meta.url))

describe('nuxt module integration', () => {
  it('generates field types, records one request, and stays within the Nitro bundle budget', async () => {
    await runNuxt(['typecheck', 'tests/fixtures/basic'])
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
        'level': 'info',
        'method': 'GET',
        'path': '/api/record',
        'service': 'integration-fixture',
        'status': 200,
        'cache.hit': true,
        'user.id': 'user_1',
      }),
    ])
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
})

interface BundleEntry {
  owner?: string
  scope: string
  totalBytes: number
}

function runNuxt(arguments_: string[], environment: Record<string, string> = {}) {
  return execFileAsync('pnpm', ['exec', 'nuxt', ...arguments_], {
    cwd: packageRoot,
    env: { ...process.env, ...environment, NO_COLOR: '1' },
    maxBuffer: 20 * 1024 * 1024,
  })
}

function processOutput(error: unknown): string {
  const output = error as { stderr?: string, stdout?: string }
  return `${output.stdout ?? ''}\n${output.stderr ?? ''}`
}

async function requestBuiltFixture(): Promise<{ logs: Record<string, unknown>[], response: unknown }> {
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

async function runRequest(
  child: ChildProcessWithoutNullStreams,
  port: number,
  output: () => string,
): Promise<{ logs: Record<string, unknown>[], response: unknown }> {
  await waitForServer(child, port, output)
  const response = await fetch(`http://127.0.0.1:${port}/api/record`).then(value => value.json())
  await waitFor(() => eventLogs(output()).length === 1, child, output)
  return { logs: eventLogs(output()), response }
}

function eventLogs(output: string): Record<string, unknown>[] {
  return output
    .split(/\r?\n/)
    .filter(line => line.startsWith('{') && line.includes('"requestId"'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
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
