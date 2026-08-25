import type { ConsolaInstance } from 'consola'
import type { DiagnosticTerminal, DiagnosticTerminalNotice } from './terminal-bridge'

interface DiagnosticTaskLabels {
  start: string
  failure: string
}

type SizeBudgetNoticeScope = 'client' | 'server'

export interface DiagnosticOutput {
  updateBudgetNotice: (scope: SizeBudgetNoticeScope, reports: readonly string[]) => void
  runTask: <T>(labels: DiagnosticTaskLabels, work: () => Promise<T>) => Promise<T>
}

export function createDiagnosticOutput(useTerminal: () => DiagnosticTerminal, logger: ConsolaInstance): DiagnosticOutput {
  const notices = new Map<SizeBudgetNoticeScope, DiagnosticTerminalNotice>()

  const dismissNotice = (scope: SizeBudgetNoticeScope) => {
    notices.get(scope)?.dismiss()
    notices.delete(scope)
  }

  return {
    updateBudgetNotice(scope, reports) {
      const terminal = useTerminal()
      dismissNotice(scope)
      if (!reports.length)
        return
      if (!terminal.interactive) {
        for (const report of reports)
          logger.warn(report)
        return
      }
      notices.set(scope, terminal.notify({
        title: `Nuxt DX: ${scope} size budget`,
        message: reports.join('\n\n'),
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
  }
}
