import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const children = new Set<ReturnType<typeof spawn>>()

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Failed to allocate a development server port')
  await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
  return address.port
}

async function waitForDevelopmentServer(
  child: ReturnType<typeof spawn>,
  url: string,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000
  let lastConnectionError: unknown
  while (Date.now() < deadline) {
    const currentOutput = output()
    if (currentOutput.includes('Generated Wrangler config is missing'))
      throw new Error(currentOutput)
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Nuxt dev exited with ${child.exitCode ?? child.signalCode}:\n${currentOutput}`)

    const response = await fetch(url).then(
      value => ({ _tag: 'ok' as const, value }),
      error => ({ _tag: 'error' as const, error }),
    )
    if (response._tag === 'ok' && response.value.ok) {
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
      return
    }
    if (response._tag === 'error')
      lastConnectionError = response.error
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`Nuxt dev startup timed out: ${String(lastConnectionError)}\n${output()}`)
}

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    children.delete(child)
  }))
})

describe('development lifecycle', () => {
  it('does not audit a production Wrangler artifact during nuxt dev', async () => {
    const port = await availablePort()
    const child = spawn(process.execPath, [
      resolve(root, 'node_modules/nuxt/bin/nuxt.mjs'),
      'dev',
      'tests/fixtures/basic',
      '--port',
      String(port),
    ], { cwd: root, env: process.env })
    children.add(child)

    let output = ''
    child.stdout.on('data', chunk => output += String(chunk))
    child.stderr.on('data', chunk => output += String(chunk))

    await waitForDevelopmentServer(child, `http://127.0.0.1:${port}/`, () => output)

    expect(output).not.toContain('Generated Wrangler config is missing')
    expect(output).not.toContain('[unhandledRejection]')
  }, 20_000)
})
