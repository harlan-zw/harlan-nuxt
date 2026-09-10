import type { ConsolaInstance } from 'consola'
import type { DiagnosticTerminal, DiagnosticTerminalNotice, DiagnosticTerminalNotification, DiagnosticTerminalPanel, DiagnosticTerminalPanelDefinition, DiagnosticTerminalPanelEntry, DiagnosticTerminalTask } from '../src/terminal-bridge'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticOutput } from '../src/diagnostic-output'

function createLogger(): ConsolaInstance {
  return { warn: vi.fn() } as unknown as ConsolaInstance
}

function createTerminal(options: {
  interactive?: boolean
  notify?: (notification: DiagnosticTerminalNotification) => DiagnosticTerminalNotice
  task?: DiagnosticTerminalTask
  registerPanel?: (definition: DiagnosticTerminalPanelDefinition) => DiagnosticTerminalPanel
} = {}): DiagnosticTerminal {
  return {
    interactive: options.interactive ?? false,
    notify: options.notify ?? (() => ({ dismiss: vi.fn(), dismissed: Promise.resolve() })),
    startTask: () => options.task ?? { update: vi.fn(), stop: vi.fn() },
    ...options.registerPanel ? { registerPanel: options.registerPanel } : {},
  }
}

function report(message: string, id = message) {
  return {
    message,
    entries: [{ id, title: message, level: 'warn' as const }] satisfies DiagnosticTerminalPanelEntry[],
  }
}

describe('diagnostic output', () => {
  it('discovers a terminal host registered after the output was created', () => {
    const notifications: DiagnosticTerminalNotification[] = []
    const logger = createLogger()
    let terminal = createTerminal()
    const output = createDiagnosticOutput(() => terminal, logger)

    output.updateBudgetDiagnostics('client', [report('First report')])
    terminal = createTerminal({
      interactive: true,
      notify: (notification) => {
        notifications.push(notification)
        return { dismiss: vi.fn(), dismissed: Promise.resolve() }
      },
    })
    output.updateBudgetDiagnostics('client', [report('Second report')])

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

    output.updateBudgetDiagnostics('client', [report('First client report')])
    output.updateBudgetDiagnostics('server', [report('Server report')])
    output.updateBudgetDiagnostics('client', [report('Second client report')])

    expect(notices[0]!.dismiss).toHaveBeenCalledOnce()
    expect(notices[1]!.dismiss).not.toHaveBeenCalled()
    output.updateBudgetDiagnostics('client', [])
    expect(notices[2]!.dismiss).toHaveBeenCalledOnce()
    expect(notices[1]!.dismiss).not.toHaveBeenCalled()
    expect(nextNotice).toBe(3)
  })

  it('keeps over-budget reports in normal Nuxt output without an interactive host', () => {
    const logger = createLogger()
    const output = createDiagnosticOutput(() => createTerminal(), logger)

    output.updateBudgetDiagnostics('client', [report('Plugin report'), report('Middleware report')])

    expect(logger.warn).toHaveBeenNthCalledWith(1, 'Plugin report')
    expect(logger.warn).toHaveBeenNthCalledWith(2, 'Middleware report')
  })

  it('publishes one live Diagnostics panel and removes resolved entries', () => {
    const definitions: DiagnosticTerminalPanelDefinition[] = []
    const panel = { update: vi.fn(), dispose: vi.fn() }
    const output = createDiagnosticOutput(() => createTerminal({
      interactive: true,
      registerPanel(definition) {
        definitions.push(definition)
        return panel
      },
    }), createLogger())
    const client = report('Client plugin over budget', 'client')
    const server = report('Server plugin over budget', 'server')

    output.updateBudgetDiagnostics('client', [client])
    output.updateBudgetDiagnostics('server', [server])
    output.updateBudgetDiagnostics('client', [])

    expect(definitions).toEqual([{
      id: 'nuxt-dx:diagnostics',
      title: 'Nuxt DX Diagnostics',
      empty: 'No Diagnostics',
      shortcut: { key: 'd', label: 'diagnostics', description: 'browse current Diagnostics' },
    }])
    expect(panel.update).toHaveBeenNthCalledWith(1, client.entries)
    expect(panel.update).toHaveBeenNthCalledWith(2, [...client.entries, ...server.entries])
    expect(panel.update).toHaveBeenNthCalledWith(3, server.entries)

    output.dispose()
    expect(panel.dispose).toHaveBeenCalledOnce()
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
