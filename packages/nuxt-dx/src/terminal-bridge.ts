import type { ConsolaInstance } from 'consola'
import * as nuxtKit from '@nuxt/kit'

export interface DiagnosticTerminalTask {
  update: (label: string) => void
  stop: (message?: string, outcome?: 'success' | 'failure') => void
}

export interface DiagnosticTerminalNotification {
  title?: string
  message: string
  level?: 'info' | 'warn'
}

export interface DiagnosticTerminalNotice {
  dismiss: () => void
  dismissed: Promise<void>
}

export interface DiagnosticTerminal {
  readonly interactive: boolean
  startTask: (label: string) => DiagnosticTerminalTask
  notify: (notification: DiagnosticTerminalNotification) => DiagnosticTerminalNotice
}

interface TerminalHostV1 {
  version: 1
  withTerminal: <T>(work: () => Promise<T>) => Promise<T>
  startTask: (label: string) => DiagnosticTerminalTask
  notify?: (notification: DiagnosticTerminalNotification) => DiagnosticTerminalNotice
}

const terminalHostKey = Symbol.for('nuxt:terminal-host')
const globals = globalThis as typeof globalThis & { [terminalHostKey]?: unknown }

function terminalHost(): TerminalHostV1 | undefined {
  const host = globals[terminalHostKey] as Partial<TerminalHostV1> | undefined
  if (host?.version !== 1 || typeof host.withTerminal !== 'function' || typeof host.startTask !== 'function')
    return undefined
  return host as TerminalHostV1
}

function useCompatibleTerminal(logger: ConsolaInstance): DiagnosticTerminal {
  const host = terminalHost()
  return {
    interactive: host !== undefined,
    startTask(label) {
      if (host)
        return host.startTask(label)
      logger.start(label)
      let stopped = false
      return {
        update(nextLabel) {
          if (!stopped)
            logger.start(nextLabel)
        },
        stop(message, outcome) {
          if (stopped)
            return
          stopped = true
          if (message)
            logger[outcome === 'failure' ? 'fail' : 'success'](message)
        },
      }
    },
    notify(notification) {
      if (host?.notify)
        return host.notify(notification)
      logger.box([notification.title, notification.message].filter(Boolean).join('\n\n'))
      return { dismiss() {}, dismissed: Promise.resolve() }
    },
  }
}

type UpstreamKit = typeof nuxtKit & {
  useTerminal?: () => DiagnosticTerminal
}

/** Use Nuxt's terminal API when present, with the same host contract on Nuxt 4. */
export function createTerminalAccess(
  logger: ConsolaInstance,
  upstream: (() => DiagnosticTerminal) | undefined = (nuxtKit as UpstreamKit).useTerminal,
): () => DiagnosticTerminal {
  return upstream ?? (() => useCompatibleTerminal(logger))
}
