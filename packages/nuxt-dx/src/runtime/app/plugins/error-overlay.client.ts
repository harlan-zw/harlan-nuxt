import type { ComponentPublicInstance } from 'vue'
import type { DiagnosticIssue } from '../report'
import { defineNuxtPlugin, useRoute, useRuntimeConfig } from '#app'
import { HYDRATION_SUMMARY_ERROR, parseComponentTrace, parseHydrationWarning } from '../hydration'
import { formatDiagnosticReport, formatIssueLine, issueSignature, relativeSourcePath } from '../report'

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

const OVERLAY_STYLES = `
:host {
  --dx-bg: rgb(8 12 20 / 96%);
  --dx-surface: rgb(17 24 39 / 94%);
  --dx-surface-hover: rgb(30 41 59 / 92%);
  --dx-border: rgb(148 163 184 / 24%);
  --dx-border-strong: rgb(148 163 184 / 42%);
  --dx-text: #f1f5f9;
  --dx-muted: #94a3b8;
  --dx-error: #fda4af;
  --dx-error-border: rgb(251 113 133 / 62%);
  --dx-warning: #fcd34d;
  --dx-warning-border: rgb(251 191 36 / 58%);
  --dx-hydration: #c4b5fd;
  --dx-hydration-border: rgb(167 139 250 / 58%);
  --dx-success: #6ee7b7;
  --dx-success-border: rgb(52 211 153 / 52%);
  position: fixed;
  z-index: 2147483000;
  inset-block-end: 0.75rem;
  color-scheme: dark;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
}

:host([data-side="left"]) { inset-inline-start: 0.75rem; }
:host([data-side="right"]) { inset-inline-end: 0.75rem; }

*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; }

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-block-size: 2.5rem;
  max-inline-size: calc(100vw - 1.5rem);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--dx-success-border);
  border-radius: 999px;
  background: var(--dx-surface);
  color: var(--dx-text);
  box-shadow: 0 0.5rem 1.75rem rgb(0 0 0 / 28%);
  backdrop-filter: blur(0.75rem);
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
}

.trigger:hover { background: var(--dx-surface-hover); }
.trigger:active { transform: translateY(1px); }
.trigger[data-status="error"] { border-color: var(--dx-error-border); }
.trigger[data-status="warning"] { border-color: var(--dx-warning-border); }
.trigger[data-status="hydration"] { border-color: var(--dx-hydration-border); }

.trigger:focus-visible,
.action:focus-visible,
.close:focus-visible {
  outline: 2px solid var(--dx-text);
  outline-offset: 2px;
}

.status-dot {
  inline-size: 0.5rem;
  block-size: 0.5rem;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--dx-success);
  box-shadow: 0 0 0 0.1875rem rgb(110 231 183 / 10%);
}

.trigger[data-status="error"] .status-dot {
  background: var(--dx-error);
  box-shadow: 0 0 0 0.1875rem rgb(253 164 175 / 10%);
}
.trigger[data-status="warning"] .status-dot {
  background: var(--dx-warning);
  box-shadow: 0 0 0 0.1875rem rgb(252 211 77 / 10%);
}
.trigger[data-status="hydration"] .status-dot {
  background: var(--dx-hydration);
  box-shadow: 0 0 0 0.1875rem rgb(196 181 253 / 10%);
}

.summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.summary-compact { display: none; }

.panel {
  position: absolute;
  inset-block-end: calc(100% + 0.5rem);
  display: flex;
  flex-direction: column;
  inline-size: min(30rem, calc(100vw - 1.5rem));
  max-block-size: min(34rem, calc(100vh - 5rem));
  overflow: hidden;
  border: 1px solid var(--dx-border-strong);
  border-radius: 1rem;
  background: var(--dx-bg);
  color: var(--dx-text);
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 42%);
  backdrop-filter: blur(1rem);
  transform-origin: bottom right;
  animation: dx-enter 140ms ease-out;
}

:host([data-side="left"]) .panel {
  inset-inline-start: 0;
  transform-origin: bottom left;
}
:host([data-side="right"]) .panel { inset-inline-end: 0; }
.panel[hidden] { display: none; }

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  border-block-end: 1px solid var(--dx-border);
}

.eyebrow {
  margin: 0 0 0.125rem;
  color: var(--dx-muted);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.count {
  margin: 0.125rem 0 0;
  color: var(--dx-muted);
  font-size: 0.75rem;
}

.close {
  min-inline-size: 2.25rem;
  min-block-size: 2.25rem;
  padding: 0 0.625rem;
  border: 1px solid var(--dx-border);
  border-radius: 0.625rem;
  background: transparent;
  color: var(--dx-muted);
  cursor: pointer;
}
.close:hover { border-color: var(--dx-border-strong); color: var(--dx-text); }

.issue-list {
  display: grid;
  gap: 0.5rem;
  min-block-size: 0;
  margin: 0;
  padding: 0.75rem;
  overflow: auto;
  list-style: none;
  overscroll-behavior: contain;
}
.issue-list[hidden] { display: none; }

.issue {
  padding: 0.75rem;
  border: 1px solid var(--dx-border);
  border-radius: 0.75rem;
  background: rgb(15 23 42 / 48%);
}

.issue-kind {
  display: inline-flex;
  margin-block-end: 0.5rem;
  padding: 0.125rem 0.4375rem;
  border: 1px solid var(--dx-error-border);
  border-radius: 999px;
  color: var(--dx-error);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.issue-kind[data-kind="warning"] { border-color: var(--dx-warning-border); color: var(--dx-warning); }
.issue-kind[data-kind="hydration"] { border-color: var(--dx-hydration-border); color: var(--dx-hydration); }

.issue-message {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--dx-text);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre-wrap;
}

.empty {
  display: grid;
  place-items: center;
  min-block-size: 10rem;
  padding: 2rem;
  color: var(--dx-muted);
  text-align: center;
}
.empty[hidden] { display: none; }
.empty strong { display: block; margin-block-end: 0.25rem; color: var(--dx-text); font-weight: 650; }

.panel-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem;
  border-block-start: 1px solid var(--dx-border);
}

.action {
  min-block-size: 2.25rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--dx-border);
  border-radius: 0.625rem;
  background: transparent;
  color: var(--dx-muted);
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
}
.action:hover { border-color: var(--dx-border-strong); background: var(--dx-surface-hover); color: var(--dx-text); }
.action[data-primary="true"] { border-color: var(--dx-success-border); color: var(--dx-text); }
.action[data-result="error"] { border-color: var(--dx-error-border); color: var(--dx-error); }

@keyframes dx-enter {
  from { opacity: 0; transform: translateY(0.25rem) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 40rem) {
  .trigger, .action, .close { min-block-size: 2.75rem; }
  .summary-full { display: none; }
  .summary-compact { display: inline; }
}

@media (prefers-reduced-motion: reduce) {
  .trigger, .action, .panel { animation: none; transition: none; }
}
`

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text?: string): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined)
    node.textContent = text
  return node
}

function issueCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'issue' : 'issues'}`
}

export default defineNuxtPlugin({
  name: 'nuxt-dx:error-overlay',
  enforce: 'pre',
  setup(nuxtApp) {
    if (!import.meta.dev)
      return

    const route = useRoute()
    const runtimeConfig = useRuntimeConfig()
    const config = (runtimeConfig.public as Record<string, unknown>).nuxtDx as DxConfig
    const issues: DiagnosticIssue[] = []
    const seen = new Set<string>()

    const host = document.createElement('div')
    host.dataset.nuxtDxOverlay = ''
    host.dataset.side = config.position === 'bottom-left' ? 'left' : 'right'
    const root = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = OVERLAY_STYLES

    const badge = element('button', 'trigger')
    badge.type = 'button'
    badge.dataset.status = 'ok'
    badge.setAttribute('aria-controls', 'nuxt-dx-panel')
    badge.setAttribute('aria-expanded', 'false')
    const statusDot = element('span', 'status-dot')
    statusDot.setAttribute('aria-hidden', 'true')
    const summary = element('span', 'summary summary-full', 'No issues')
    const compactSummary = element('span', 'summary summary-compact', 'No issues')
    badge.append(statusDot, summary, compactSummary)

    const panel = element('section', 'panel')
    panel.id = 'nuxt-dx-panel'
    panel.hidden = true
    panel.setAttribute('aria-labelledby', 'nuxt-dx-title')

    const header = element('header', 'panel-header')
    const headingGroup = element('div', 'heading-group')
    const eyebrow = element('p', 'eyebrow', 'Nuxt DX')
    const title = element('h2', 'title', 'Development issues')
    title.id = 'nuxt-dx-title'
    const panelCount = element('p', 'count', 'No issues detected')
    headingGroup.append(eyebrow, title, panelCount)
    const closeButton = element('button', 'close', 'Close')
    closeButton.type = 'button'
    header.append(headingGroup, closeButton)

    const issueList = element('ol', 'issue-list')
    issueList.hidden = true
    const empty = element('div', 'empty')
    const emptyContent = element('div', 'empty-content')
    emptyContent.append(
      element('strong', 'empty-title', 'No issues detected'),
      element('span', 'empty-copy', 'Warnings and errors will appear here.'),
    )
    empty.append(emptyContent)

    const footer = element('footer', 'panel-footer')
    const clearButton = element('button', 'action', 'Clear')
    clearButton.type = 'button'
    const copyButton = element('button', 'action', 'Copy report')
    copyButton.type = 'button'
    copyButton.dataset.primary = 'true'
    footer.append(clearButton, copyButton)

    panel.append(header, issueList, empty, footer)
    root.append(style, badge, panel)
    document.body.append(host)

    let copyResetTimer: ReturnType<typeof setTimeout> | undefined

    const render = () => {
      const count = (kind: DiagnosticIssue['kind']) => issues.filter(issue => issue.kind === kind).length
      const errors = count('error')
      const warnings = count('warning')
      const hydration = count('hydration')
      const counts = [
        errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : '',
        warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : '',
        hydration ? `${hydration} hydration` : '',
      ].filter(Boolean)

      summary.textContent = counts.join(' · ') || 'No issues'
      compactSummary.textContent = issues.length ? issueCountLabel(issues.length) : 'No issues'
      panelCount.textContent = issues.length ? issueCountLabel(issues.length) : 'No issues detected'
      badge.dataset.status = errors ? 'error' : hydration ? 'hydration' : warnings ? 'warning' : 'ok'
      badge.setAttribute('aria-label', `Nuxt DX: ${counts.join(', ') || 'no issues'}`)

      issueList.replaceChildren(...issues.map((issue) => {
        const item = element('li', 'issue')
        const kind = element('span', 'issue-kind', issue.kind)
        kind.dataset.kind = issue.kind
        item.append(kind, element('pre', 'issue-message', formatIssueLine(issue)))
        return item
      }))
      issueList.hidden = issues.length === 0
      empty.hidden = issues.length > 0
    }

    const addIssue = (issue: DiagnosticIssue) => {
      const key = issueSignature(issue)
      if (seen.has(key))
        return
      seen.add(key)
      issues.push(issue)
      render()
    }

    const removeIssueHook = nuxtApp.hook('nuxt-dx:issue', addIssue)

    const setPanelOpen = (open: boolean, restoreFocus = false) => {
      panel.hidden = !open
      badge.setAttribute('aria-expanded', String(open))
      if (!open && restoreFocus)
        badge.focus()
    }

    const sourceFile = (instance: ComponentPublicInstance | null): string | undefined => {
      const file = (instance as DebugComponent | null)?.$?.type?.__file
      return file ? relativeSourcePath(file, config.sourceRoot) : undefined
    }
    const sourceDetails = (instance: ComponentPublicInstance | null): string => {
      const file = sourceFile(instance)
      return file ? `\n  file: ${file}` : ''
    }

    const originalConsoleError = console.error
    const previousWarnHandler = nuxtApp.vueApp.config.warnHandler
    const previousErrorHandler = nuxtApp.vueApp.config.errorHandler

    const warnHandler: typeof previousWarnHandler = (message, instance, trace) => {
      const mismatch = parseHydrationWarning(message.trim())
      if (mismatch) {
        const chain = parseComponentTrace(trace)
        const issue: DiagnosticIssue = { kind: 'hydration', mismatch, component: chain[0], componentFile: sourceFile(instance), trace: chain }
        addIssue(issue)
        console.warn(`[nuxt-dx] ${formatIssueLine(issue)}`)
        return
      }
      const formatted = `${message.trim()}${sourceDetails(instance)}`
      addIssue({ kind: 'warning', message: formatted })
      console.warn(`[Vue warn]: ${formatted}`)
    }
    const errorHandler: typeof previousErrorHandler = (error, instance, info) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      const formatted = `${info}: ${message}${sourceDetails(instance)}`
      addIssue({ kind: 'error', message: formatted })
      originalConsoleError(`[Vue error]: ${formatted}`)
    }
    nuxtApp.vueApp.config.warnHandler = warnHandler
    nuxtApp.vueApp.config.errorHandler = errorHandler

    const patchedConsoleError = (...args: unknown[]) => {
      const message = args.map(value => value instanceof Error ? value.stack ?? value.message : String(value)).join(' ').trim()
      // Vue logs its hydration summary after warning about each mismatch, which the panel already lists.
      if (message && !message.startsWith('[Vue error]:') && message !== HYDRATION_SUMMARY_ERROR)
        addIssue({ kind: 'error', message })
      originalConsoleError(...args)
    }
    console.error = patchedConsoleError

    const onWindowError = (event: ErrorEvent) => addIssue({ kind: 'error', message: event.message || String(event.error) })
    const onUnhandledRejection = (event: PromiseRejectionEvent) => addIssue({ kind: 'error', message: `Unhandled rejection: ${String(event.reason)}` })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !panel.hidden)
        setPanelOpen(false, true)
    }
    window.addEventListener('error', onWindowError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    window.addEventListener('keydown', onKeyDown)

    badge.addEventListener('click', () => setPanelOpen(panel.hidden))
    closeButton.addEventListener('click', () => setPanelOpen(false, true))
    clearButton.addEventListener('click', () => {
      issues.length = 0
      seen.clear()
      render()
    })
    copyButton.addEventListener('click', () => {
      const pageFile = (route.matched.at(-1)?.components?.default as { __file?: string } | undefined)?.__file
      const report = formatDiagnosticReport({
        url: `${window.location.origin}${route.fullPath}`,
        routeName: String(route.name),
        pageComponent: pageFile ? relativeSourcePath(pageFile, config.sourceRoot) : undefined,
        issues,
      })
      navigator.clipboard.writeText(report).then(() => {
        copyButton.textContent = 'Copied'
        delete copyButton.dataset.result
        if (copyResetTimer)
          clearTimeout(copyResetTimer)
        copyResetTimer = setTimeout(() => {
          copyButton.textContent = 'Copy report'
          delete copyButton.dataset.result
        }, 1_500)
      }).catch((error) => {
        copyButton.textContent = 'Copy failed'
        copyButton.dataset.result = 'error'
        if (copyResetTimer)
          clearTimeout(copyResetTimer)
        copyResetTimer = setTimeout(() => {
          copyButton.textContent = 'Copy report'
          delete copyButton.dataset.result
        }, 1_500)
        originalConsoleError('[nuxt-dx] clipboard failed', error)
      })
    })

    const cleanup = () => {
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
      window.removeEventListener('keydown', onKeyDown)
      removeIssueHook()
      if (copyResetTimer)
        clearTimeout(copyResetTimer)
      if (console.error === patchedConsoleError)
        console.error = originalConsoleError
      if (nuxtApp.vueApp.config.warnHandler === warnHandler)
        nuxtApp.vueApp.config.warnHandler = previousWarnHandler
      if (nuxtApp.vueApp.config.errorHandler === errorHandler)
        nuxtApp.vueApp.config.errorHandler = previousErrorHandler
      host.remove()
    }
    import.meta.hot?.dispose(cleanup)
    render()
  },
})
