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

export interface DiagnosticTerminalPanelEntry {
  id: string
  title: string
  lines?: readonly string[]
  level?: 'info' | 'warn' | 'error'
  copy?: string
  file?: { path: string, line?: number, column?: number }
}

export interface DiagnosticTerminalPanelDefinition {
  id: string
  title: string
  empty?: string
  shortcut?: { key: string, label: string, description: string }
}

export interface DiagnosticTerminalPanel {
  update: (entries: readonly DiagnosticTerminalPanelEntry[]) => void
  dispose: () => void
}

export interface DiagnosticTerminal {
  readonly interactive: boolean
  startTask: (label: string) => DiagnosticTerminalTask
  notify: (notification: DiagnosticTerminalNotification) => DiagnosticTerminalNotice
  registerPanel?: (definition: DiagnosticTerminalPanelDefinition) => DiagnosticTerminalPanel
}

interface TerminalHostV1 {
  version: 1
  withTerminal: <T>(work: () => Promise<T>) => Promise<T>
  startTask: (label: string) => DiagnosticTerminalTask
  notify?: (notification: DiagnosticTerminalNotification) => DiagnosticTerminalNotice
  registerPanel?: (definition: DiagnosticTerminalPanelDefinition) => DiagnosticTerminalPanel
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
    ...host?.registerPanel ? { registerPanel: host.registerPanel.bind(host) } : {},
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
  return () => {
    const compatible = useCompatibleTerminal(logger)
    if (!upstream)
      return compatible
    const terminal = upstream()
    return {
      ...terminal,
      interactive: terminal.interactive || compatible.interactive,
      ...terminal.registerPanel
        ? { registerPanel: terminal.registerPanel }
        : compatible.registerPanel
          ? { registerPanel: compatible.registerPanel }
          : {},
    }
  }
}
