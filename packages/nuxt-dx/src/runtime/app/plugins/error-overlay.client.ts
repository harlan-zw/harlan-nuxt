import type { ComponentPublicInstance } from 'vue'
import type { DiagnosticIssue } from '../report'
import { defineNuxtPlugin, useRoute, useRuntimeConfig } from '#app'
import { formatDiagnosticReport, relativeSourcePath } from '../report'

interface DebugComponent extends ComponentPublicInstance {
  $: ComponentPublicInstance['$'] & {
    type?: { __file?: string, __name?: string, name?: string }
    parent?: DebugComponent['$'] | null
  }
}

interface DxConfig {
  position: 'bottom-left' | 'bottom-right'
  sourceRoot: string
}

export default defineNuxtPlugin((nuxtApp) => {
  if (!import.meta.dev)
    return

  const route = useRoute()
  const runtimeConfig = useRuntimeConfig()
  const config = (runtimeConfig.public as Record<string, unknown>).nuxtDx as DxConfig
  const issues: DiagnosticIssue[] = []
  const seen = new Set<string>()
  const side = config.position === 'bottom-left' ? 'left' : 'right'

  const badge = document.createElement('button')
  Object.assign(badge.style, {
    position: 'fixed',
    bottom: '12px',
    [side]: '12px',
    zIndex: '99999',
    border: '0',
    borderRadius: '20px',
    padding: '8px 14px',
    color: 'white',
    cursor: 'pointer',
    font: '13px ui-monospace, monospace',
    boxShadow: '0 2px 8px rgb(0 0 0 / 30%)',
  })
  badge.type = 'button'

  const panel = document.createElement('section')
  Object.assign(panel.style, {
    position: 'fixed',
    bottom: '52px',
    [side]: '12px',
    zIndex: '99998',
    display: 'none',
    flexDirection: 'column',
    maxWidth: '600px',
    maxHeight: '400px',
    overflow: 'auto',
    padding: '12px',
    border: '1px solid #333',
    borderRadius: '8px',
    background: '#1a1a2e',
    color: '#e0e0e0',
    font: '12px ui-monospace, monospace',
    whiteSpace: 'pre-wrap',
  })

  const actions = document.createElement('div')
  Object.assign(actions.style, { display: 'flex', gap: '6px', marginBottom: '8px' })
  const content = document.createElement('pre')
  Object.assign(content.style, { margin: '0', whiteSpace: 'pre-wrap' })
  panel.append(actions, content)
  document.body.append(badge, panel)

  const render = () => {
    const errors = issues.filter(issue => issue.kind === 'error').length
    const warnings = issues.length - errors
    badge.textContent = issues.length ? `${errors} err | ${warnings} warn` : '0 issues'
    badge.style.background = errors ? '#dc2626' : warnings ? '#ca8a04' : '#16a34a'
    content.textContent = issues.map(issue => `${issue.kind === 'error' ? 'ERR' : 'WARN'} ${issue.message}`).join('\n\n') || 'No issues'
  }

  const addIssue = (kind: DiagnosticIssue['kind'], message: string) => {
    const key = `${kind}:${message}`
    if (seen.has(key))
      return
    seen.add(key)
    issues.push({ kind, message })
    render()
  }

  const sourceDetails = (instance: ComponentPublicInstance | null): string => {
    const debug = instance as DebugComponent | null
    const file = debug?.$?.type?.__file
    return file ? `\n  file: ${relativeSourcePath(file, config.sourceRoot)}` : ''
  }

  const makeButton = (label: string, action: () => void) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', action)
    return button
  }

  const originalConsoleError = console.error
  const previousWarnHandler = nuxtApp.vueApp.config.warnHandler
  const previousErrorHandler = nuxtApp.vueApp.config.errorHandler

  const warnHandler: typeof previousWarnHandler = (message, instance) => {
    const formatted = `${message.trim()}${sourceDetails(instance)}`
    addIssue('warning', formatted)
    console.warn(`[Vue warn]: ${formatted}`)
  }
  const errorHandler: typeof previousErrorHandler = (error, instance, info) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    const formatted = `${info}: ${message}${sourceDetails(instance)}`
    addIssue('error', formatted)
    originalConsoleError(`[Vue error]: ${formatted}`)
  }
  nuxtApp.vueApp.config.warnHandler = warnHandler
  nuxtApp.vueApp.config.errorHandler = errorHandler

  const patchedConsoleError = (...args: unknown[]) => {
    const message = args.map(value => value instanceof Error ? value.stack ?? value.message : String(value)).join(' ').trim()
    if (message && !message.startsWith('[Vue error]:'))
      addIssue('error', message)
    originalConsoleError(...args)
  }
  console.error = patchedConsoleError

  const onWindowError = (event: ErrorEvent) => addIssue('error', event.message || String(event.error))
  const onUnhandledRejection = (event: PromiseRejectionEvent) => addIssue('error', `Unhandled rejection: ${String(event.reason)}`)
  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)

  badge.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'
  })
  actions.append(
    makeButton('Copy', () => {
      const pageFile = (route.matched.at(-1)?.components?.default as { __file?: string } | undefined)?.__file
      const report = formatDiagnosticReport({
        url: `${window.location.origin}${route.fullPath}`,
        routeName: String(route.name),
        pageComponent: pageFile ? relativeSourcePath(pageFile, config.sourceRoot) : undefined,
        issues,
      })
      navigator.clipboard.writeText(report).catch(error => originalConsoleError('[nuxt-dx] clipboard failed', error))
    }),
    makeButton('Clear', () => {
      issues.length = 0
      seen.clear()
      render()
    }),
  )

  const cleanup = () => {
    window.removeEventListener('error', onWindowError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
    if (console.error === patchedConsoleError)
      console.error = originalConsoleError
    if (nuxtApp.vueApp.config.warnHandler === warnHandler)
      nuxtApp.vueApp.config.warnHandler = previousWarnHandler
    if (nuxtApp.vueApp.config.errorHandler === errorHandler)
      nuxtApp.vueApp.config.errorHandler = previousErrorHandler
    badge.remove()
    panel.remove()
  }
  import.meta.hot?.dispose(cleanup)
  render()
})
