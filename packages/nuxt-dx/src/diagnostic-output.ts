import type { ConsolaInstance } from 'consola'
import type { DiagnosticTerminal, DiagnosticTerminalNotice, DiagnosticTerminalPanel, DiagnosticTerminalPanelEntry } from './terminal-bridge'

interface DiagnosticTaskLabels {
  start: string
  failure: string
}

type SizeBudgetNoticeScope = 'client' | 'server'

export interface BudgetNoticeReport {
  message: string
  entries: readonly DiagnosticTerminalPanelEntry[]
}

export interface DiagnosticOutput {
  updateBudgetDiagnostics: (scope: SizeBudgetNoticeScope, reports: readonly BudgetNoticeReport[]) => void
  runTask: <T>(labels: DiagnosticTaskLabels, work: () => Promise<T>) => Promise<T>
  dispose: () => void
}

export function createDiagnosticOutput(useTerminal: () => DiagnosticTerminal, logger: ConsolaInstance): DiagnosticOutput {
  const notices = new Map<SizeBudgetNoticeScope, DiagnosticTerminalNotice>()
  const reports = new Map<SizeBudgetNoticeScope, readonly BudgetNoticeReport[]>()
  let panel: DiagnosticTerminalPanel | undefined

  const dismissNotice = (scope: SizeBudgetNoticeScope) => {
    notices.get(scope)?.dismiss()
    notices.delete(scope)
  }

  return {
    updateBudgetDiagnostics(scope, nextReports) {
      const terminal = useTerminal()
      reports.set(scope, nextReports)
      dismissNotice(scope)
      if (!panel && terminal.registerPanel) {
        panel = terminal.registerPanel({
          id: 'nuxt-dx:diagnostics',
          title: 'Nuxt DX Diagnostics',
          empty: 'No Diagnostics',
          shortcut: { key: 'd', label: 'diagnostics', description: 'browse current Diagnostics' },
        })
      }
      if (panel) {
        for (const noticeScope of notices.keys())
          dismissNotice(noticeScope)
        panel.update([...reports.values()].flatMap(report => report.flatMap(entry => entry.entries)))
        return
      }
      if (!nextReports.length)
        return
      if (!terminal.interactive) {
        for (const report of nextReports)
          logger.warn(report.message)
        return
      }
      notices.set(scope, terminal.notify({
        title: `Nuxt DX: ${scope} size budget`,
        message: nextReports.map(report => report.message).join('\n\n'),
        level: 'warn',
      }))
    },
    runTask(labels, work) {
      const terminal = useTerminal()
      if (!terminal.interactive)
        return Promise.resolve().then(work)

      const task = terminal.startTask(labels.start)
      return Promise.resolve()
        .then(work)
        .then((result) => {
          task.stop()
          return result
        }, (error) => {
          task.stop(labels.failure, 'failure')
          throw error
        })
    },
    dispose() {
      for (const scope of notices.keys())
        dismissNotice(scope)
      panel?.dispose()
      panel = undefined
      reports.clear()
    },
  }
}
