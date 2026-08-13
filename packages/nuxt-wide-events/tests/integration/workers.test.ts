import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const fixture = fileURLToPath(new URL('../fixtures/workers', import.meta.url))

describe('cloudflare Workers integration', () => {
  it('runs one safe Wide Event inside workerd', async () => {
    await command('pnpm', ['exec', 'nuxt', 'build', 'tests/fixtures/workers'], packageRoot)
    await command('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--cwd', fixture], packageRoot)

    const port = await availablePort()
    const child = spawn('pnpm', [
      'exec',
      'wrangler',
      'dev',
      '--cwd',
      fixture,
      '--local',
      '--port',
      String(port),
      '--show-interactive-dev-session=false',
    ], {
      cwd: packageRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: 'pipe',
    })
    let output = ''
    child.stdout.on('data', chunk => output += String(chunk))
    child.stderr.on('data', chunk => output += String(chunk))

    try {
      await waitFor(() => canFetch(port), child, () => output)
      await waitFor(() => eventLogs(output).length > 0, child, () => output)
      output = ''
      const response = await fetch(`http://127.0.0.1:${port}/api/record?token=secret-query-token`)
        .then(value => value.json())
      await waitFor(() => eventLogs(output).length === 1, child, () => output)

      expect(response).toEqual({ recorded: true })
      expect(eventLogs(output)).toEqual([
        expect.objectContaining({
          'level': 'info',
          'method': 'GET',
          'path': '/api/record',
          'service': 'workers-fixture',
          'status': 200,
          'worker.ok': true,
        }),
      ])
      expect(JSON.stringify(eventLogs(output))).not.toContain('secret-query-token')
    }
    finally {
      child.kill('SIGTERM')
    }
  }, 120_000)
})

function command(program: string, arguments_: string[], cwd: string): Promise<void> {
  return execFileAsync(program, arguments_, {
    cwd,
    env: { ...process.env, NO_COLOR: '1', NUXT_IGNORE_LOCK: '1' },
    maxBuffer: 20 * 1024 * 1024,
  }).then(() => undefined)
}

function eventLogs(output: string): Record<string, unknown>[] {
  return output
    .split(/\r?\n/)
    .map(line => line.slice(line.indexOf('{')))
    .filter(line => line.startsWith('{') && line.includes('"requestId"'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition())
      return
    if (child.exitCode !== null)
      throw new Error(`Wrangler exited with ${child.exitCode}.\n${output()}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Wrangler did not become ready.\n${output()}`)
}

function canFetch(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/api/record`)
    .then(response => response.ok)
    .catch(() => false)
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
