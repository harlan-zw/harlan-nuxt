import type { NuxtLogger, NuxtTerminal } from '@nuxt/kit'

interface DiagnosticTaskLabels {
  start: string
  success: string
}

export interface DiagnosticOutput {
  warn: (message: string) => void
  runTask: <T>(labels: DiagnosticTaskLabels, work: () => Promise<T>) => Promise<T>
}

export function createDiagnosticOutput(terminal: NuxtTerminal, logger: NuxtLogger): DiagnosticOutput {
  return {
    warn(message) {
      if (!terminal.interactive) {
        logger.warn(message)
        return
      }
      terminal.notify({
        title: 'Nuxt DX diagnostic',
        message,
        level: 'warn',
      })
    },
    runTask(labels, work) {
      if (!terminal.interactive)
        return Promise.resolve().then(work)

      const task = terminal.startTask(labels.start)
      return Promise.resolve()
        .then(work)
        .then((result) => {
          task.stop(labels.success)
          return result
        }, (error) => {
          task.stop(undefined, 'failure')
          throw error
        })
    },
  }
}
