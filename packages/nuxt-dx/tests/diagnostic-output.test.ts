import type { ConsolaInstance } from 'consola'
import type { DiagnosticTerminal, DiagnosticTerminalNotice, DiagnosticTerminalNotification, DiagnosticTerminalTask } from '../src/terminal-bridge'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticOutput } from '../src/diagnostic-output'

function createLogger(): ConsolaInstance {
  return { warn: vi.fn() } as unknown as ConsolaInstance
}

function createTerminal(options: {
  interactive?: boolean
  notify?: (notification: DiagnosticTerminalNotification) => DiagnosticTerminalNotice
  task?: DiagnosticTerminalTask
} = {}): DiagnosticTerminal {
  return {
    interactive: options.interactive ?? false,
    notify: options.notify ?? (() => ({ dismiss: vi.fn(), dismissed: Promise.resolve() })),
    startTask: () => options.task ?? { update: vi.fn(), stop: vi.fn() },
  }
}

describe('diagnostic output', () => {
  it('discovers a terminal host registered after the output was created', () => {
    const notifications: DiagnosticTerminalNotification[] = []
    const logger = createLogger()
    let terminal = createTerminal()
    const output = createDiagnosticOutput(() => terminal, logger)

    output.updateBudgetNotice('client', ['First report'])
    terminal = createTerminal({
      interactive: true,
      notify: (notification) => {
        notifications.push(notification)
        return { dismiss: vi.fn(), dismissed: Promise.resolve() }
      },
    })
    output.updateBudgetNotice('client', ['Second report'])

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('First report')
    expect(notifications).toEqual([{
      title: 'Nuxt DX: client size budget',
      message: 'Second report',
      level: 'warn',
    }])
  })

  it('replaces and clears the prior notice for one scope', () => {
    const notices = Array.from({ length: 3 }, () => ({ dismiss: vi.fn(), dismissed: Promise.resolve() }))
    let nextNotice = 0
    const terminal = createTerminal({
      interactive: true,
      notify: () => notices[nextNotice++]!,
    })
    const output = createDiagnosticOutput(() => terminal, createLogger())

    output.updateBudgetNotice('client', ['First client report'])
    output.updateBudgetNotice('server', ['Server report'])
    output.updateBudgetNotice('client', ['Second client report'])

    expect(notices[0]!.dismiss).toHaveBeenCalledOnce()
    expect(notices[1]!.dismiss).not.toHaveBeenCalled()
    output.updateBudgetNotice('client', [])
    expect(notices[2]!.dismiss).toHaveBeenCalledOnce()
    expect(notices[1]!.dismiss).not.toHaveBeenCalled()
    expect(nextNotice).toBe(3)
  })

  it('keeps over-budget reports in normal Nuxt output without an interactive host', () => {
    const logger = createLogger()
    const output = createDiagnosticOutput(() => createTerminal(), logger)

    output.updateBudgetNotice('client', ['Plugin report', 'Middleware report'])

    expect(logger.warn).toHaveBeenNthCalledWith(1, 'Plugin report')
    expect(logger.warn).toHaveBeenNthCalledWith(2, 'Middleware report')
  })

  it('removes a completed task without adding a history entry', async () => {
    const task = { update: vi.fn(), stop: vi.fn() }
    let terminal = createTerminal()
    const output = createDiagnosticOutput(() => terminal, createLogger())
    terminal = createTerminal({ interactive: true, task })

    await expect(output.runTask({
      start: 'Checking runtime size budgets',
      failure: 'Failed to check runtime size budgets',
    }, async () => 'done')).resolves.toBe('done')

    expect(task.stop).toHaveBeenCalledExactlyOnceWith()
  })

  it('marks a failed terminal task before propagating the error', async () => {
    const task = { update: vi.fn(), stop: vi.fn() }
    const output = createDiagnosticOutput(
      () => createTerminal({ interactive: true, task }),
      createLogger(),
    )
    const failure = new Error('budget failed')

    await expect(output.runTask({
      start: 'Checking runtime size budgets',
      failure: 'Failed to check runtime size budgets',
    }, async () => { throw failure })).rejects.toBe(failure)

    expect(task.stop).toHaveBeenCalledExactlyOnceWith('Failed to check runtime size budgets', 'failure')
  })

  it('does not add task logs without an interactive host', async () => {
    const task = { update: vi.fn(), stop: vi.fn() }
    const output = createDiagnosticOutput(() => createTerminal({ task }), createLogger())

    await output.runTask({
      start: 'Checking runtime size budgets',
      failure: 'Failed to check runtime size budgets',
    }, async () => 'done')

    expect(task.stop).not.toHaveBeenCalled()
  })
})
