// @vitest-environment node

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const runE2E = process.env.CF_JOBS_E2E === '1'
const describeE2E = runE2E ? describe : describe.skip

async function getAvailablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Unable to allocate a local port')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

async function waitForJsonUntil<T>(url: string, predicate: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  let lastValue: T | undefined

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        const value = await response.json() as T
        if (predicate(value))
          return value
        lastValue = value
      }
      else {
        lastError = new Error(`HTTP ${response.status}`)
      }
    }
    catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  if (lastValue !== undefined)
    throw new Error(`Timed out waiting for ${url}; last value: ${JSON.stringify(lastValue)}`)
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

describeE2E('nuxt-cf-jobs wrangler d1 e2e', () => {
  let worker: ChildProcessWithoutNullStreams
  let baseUrl: string
  let logs = ''

  beforeAll(async () => {
    const port = await getAvailablePort()
    baseUrl = `http://127.0.0.1:${port}`
    const config = resolve('tests/fixtures/wrangler-d1.toml')

    worker = spawn('pnpm', [
      'exec',
      'wrangler',
      'dev',
      '--config',
      config,
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--log-level',
      'error',
    ], {
      cwd: resolve('tests/fixtures'),
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
    })

    worker.stdout.on('data', chunk => logs += chunk.toString())
    worker.stderr.on('data', chunk => logs += chunk.toString())

    await waitForJsonUntil(`${baseUrl}/health`, () => true)
    await fetch(`${baseUrl}/reset`, { method: 'POST' })
  }, 120_000)

  afterAll(async () => {
    if (!worker || worker.killed)
      return

    worker.kill('SIGTERM')
    await Promise.race([
      once(worker, 'exit'),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ])
    if (!worker.killed)
      worker.kill('SIGKILL')
  })

  it('persists, claims, handles, and completes a D1-backed queued job', async () => {
    const response = await fetch(`${baseUrl}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'd1/succeed', message: 'database' }),
    })
    expect(response.status, logs).toBe(200)
    const queued = await response.json() as { id: string, traceId: string, uniqueKey: string }

    expect(queued.traceId).toMatch(/^job_/)
    expect(queued.uniqueKey).toMatch(/^job_unique_/)

    const state = await waitForJsonUntil<{
      job: null | { completed_at: number | null, attempts: number, rows_fetched: number | null, rows_inserted: number | null, trace_id: string | null, unique_key: string | null }
      failed: null
    }>(
      `${baseUrl}/jobs/${queued.id}`,
      state => typeof state.job?.completed_at === 'number',
      30_000,
    )

    expect(state.failed, logs).toBeNull()
    expect(state.job?.completed_at, logs).toEqual(expect.any(Number))
    expect(state.job?.attempts).toBe(1)
    expect(state.job?.rows_fetched).toBe(8)
    expect(state.job?.rows_inserted).toBe(1)
    expect(state.job?.trace_id).toBe(queued.traceId)
    expect(state.job?.unique_key).toBe(queued.uniqueKey)
  }, 45_000)

  it('moves explicitly failed jobs into failed_jobs with trace metadata', async () => {
    const response = await fetch(`${baseUrl}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'd1/fail', message: 'fail' }),
    })
    expect(response.status, logs).toBe(200)
    const queued = await response.json() as { id: string, traceId: string }

    const state = await waitForJsonUntil<{
      job: null
      failed: null | { exception: string, attempts: number, trace_id: string | null }
    }>(
      `${baseUrl}/jobs/${queued.id}`,
      state => !!state.failed,
      30_000,
    )

    expect(state.job, logs).toBeNull()
    expect(state.failed?.exception).toBe('forced failure')
    expect(state.failed?.attempts).toBe(1)
    expect(state.failed?.trace_id).toBe(queued.traceId)
  }, 45_000)
})
