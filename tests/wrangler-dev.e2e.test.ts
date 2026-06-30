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

describeE2E('nuxt-cf-jobs wrangler dev e2e', () => {
  let worker: ChildProcessWithoutNullStreams
  let baseUrl: string
  let logs = ''

  beforeAll(async () => {
    const port = await getAvailablePort()
    baseUrl = `http://127.0.0.1:${port}`
    const config = resolve('tests/fixtures/wrangler.toml')

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

    try {
      await waitForJsonUntil(`${baseUrl}/state`, () => true)
    }
    catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error)
      throw new Error(`${detail}\n\nwrangler logs:\n${logs}`)
    }
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

  it('dispatches through a local Cloudflare Queue producer and consumer', async () => {
    const response = await fetch(`${baseUrl}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'wrangler' }),
    })

    expect(response.status, logs).toBe(200)
    expect(await response.json()).toEqual({ queued: true })

    const state = await waitForJsonUntil<{
      handled: string[]
      middleware: string[]
      failures: string[]
    }>(
      `${baseUrl}/state`,
      state => state.handled.includes('wrangler') && state.middleware.includes('after:wrangler'),
      30_000,
    )

    expect(state.failures, logs).toEqual([])
    expect(state.handled).toEqual(['wrangler'])
    expect(state.middleware).toEqual(['before:wrangler', 'after:wrangler'])
  }, 45_000)
})
