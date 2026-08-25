import type { NuxtLogger, NuxtTerminal, NuxtTerminalNotification, NuxtTerminalTask } from '@nuxt/kit'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticOutput } from '../src/diagnostic-output'

function createLogger(): NuxtLogger {
  return { warn: vi.fn() } as unknown as NuxtLogger
}

function createTerminal(options: {
  interactive?: boolean
  notify?: (notification: NuxtTerminalNotification) => void
  task?: NuxtTerminalTask
} = {}): NuxtTerminal {
  return {
    interactive: options.interactive ?? false,
    withTerminal: work => work(),
    prompt: vi.fn(),
    notify: (notification) => {
      options.notify?.(notification)
      return { dismiss: vi.fn(), dismissed: Promise.resolve() }
    },
    startTask: () => options.task ?? { update: vi.fn(), stop: vi.fn() },
  }
}

describe('diagnostic output', () => {
  it('holds an interactive warning in the Nuxt terminal', () => {
    const notifications: NuxtTerminalNotification[] = []
    const logger = createLogger()
    const output = createDiagnosticOutput(createTerminal({
      interactive: true,
      notify: notification => notifications.push(notification),
    }), logger)

    output.warn('One Nuxt plugin is over budget.')

    expect(notifications).toEqual([{
      title: 'Nuxt DX diagnostic',
      message: 'One Nuxt plugin is over budget.',
      level: 'warn',
    }])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('keeps a warning in normal Nuxt output without an interactive host', () => {
    const logger = createLogger()
    const output = createDiagnosticOutput(createTerminal(), logger)

    output.warn('One Nuxt plugin is over budget.')

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('One Nuxt plugin is over budget.')
  })

  it('reports task completion to the terminal host', async () => {
    const task = { update: vi.fn(), stop: vi.fn() }
    const output = createDiagnosticOutput(createTerminal({ interactive: true, task }), createLogger())

    await expect(output.runTask({
      start: 'Checking runtime size budgets',
      success: 'Checked runtime size budgets',
    }, async () => 'done')).resolves.toBe('done')

    expect(task.stop).toHaveBeenCalledExactlyOnceWith('Checked runtime size budgets')
  })

  it('marks a failed terminal task before propagating the error', async () => {
    const task = { update: vi.fn(), stop: vi.fn() }
    const output = createDiagnosticOutput(createTerminal({ interactive: true, task }), createLogger())
    const failure = new Error('budget failed')

    await expect(output.runTask({
      start: 'Checking runtime size budgets',
      success: 'Checked runtime size budgets',
    }, async () => { throw failure })).rejects.toBe(failure)

    expect(task.stop).toHaveBeenCalledExactlyOnceWith(undefined, 'failure')
  })

  it('does not add task logs without an interactive host', async () => {
    const task = { update: vi.fn(), stop: vi.fn() }
    const output = createDiagnosticOutput(createTerminal({ task }), createLogger())

    await output.runTask({
      start: 'Checking runtime size budgets',
      success: 'Checked runtime size budgets',
    }, async () => 'done')

    expect(task.stop).not.toHaveBeenCalled()
  })
})
