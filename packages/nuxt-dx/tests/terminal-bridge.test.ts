import type { ConsolaInstance } from 'consola'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiagnosticOutput } from '../src/diagnostic-output'
import { createTerminalAccess } from '../src/terminal-bridge'

const terminalHostKey = Symbol.for('nuxt:terminal-host')
const globals = globalThis as typeof globalThis & { [terminalHostKey]?: unknown }

afterEach(() => {
  delete globals[terminalHostKey]
})

function createLogger(): ConsolaInstance {
  return {
    box: vi.fn(),
    fail: vi.fn(),
    start: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  } as unknown as ConsolaInstance
}

describe('terminal bridge', () => {
  it('prefers Nuxt useTerminal when the installed Kit provides it', async () => {
    const logger = createLogger()
    const stop = vi.fn()
    const upstream = vi.fn(() => ({
      interactive: true,
      notify: vi.fn(),
      startTask: () => ({ update: vi.fn(), stop }),
    }))
    const output = createDiagnosticOutput(createTerminalAccess(logger, upstream), logger)

    await output.runTask({
      start: 'Checking server runtime size budgets',
      failure: 'Failed to check server runtime size budgets',
    }, async () => {})

    expect(upstream).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledExactlyOnceWith()
  })

  it('uses a host registered between initial work and a rebuild', async () => {
    const events: string[] = []
    const logger = createLogger()
    const output = createDiagnosticOutput(createTerminalAccess(logger), logger)
    const labels = {
      start: 'Checking server runtime size budgets',
      failure: 'Failed to check server runtime size budgets',
    }

    await output.runTask(labels, async () => {})
    globals[terminalHostKey] = {
      version: 1,
      withTerminal: async (work: () => Promise<unknown>) => work(),
      startTask(label: string) {
        events.push(`start:${label}`)
        return {
          update() {},
          stop(message?: string) {
            events.push(`stop:${message ?? ''}`)
          },
        }
      },
    }
    await output.runTask(labels, async () => {})
    delete globals[terminalHostKey]
    await output.runTask(labels, async () => {})

    expect(events).toEqual([
      'start:Checking server runtime size budgets',
      'stop:',
    ])
  })
})
