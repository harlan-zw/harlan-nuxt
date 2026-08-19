import type { ComponentPublicInstance } from 'vue'
import type { DiagnosticIssue } from '../report'
import { useEventListener, useStorage } from '@vueuse/core'
import { effectScope } from 'vue'
import { defineNuxtPlugin, useRoute, useRuntimeConfig } from '#app'
import { chainHandler } from '../handler-chain'
import { HYDRATION_SUMMARY_ERROR, parseComponentTrace, parseHydrationWarning } from '../hydration'
import { formatDiagnosticReport, formatIssueLine, issueSignature, relativeSourcePath } from '../report'

type VueWarnHandler = (message: string, instance: ComponentPublicInstance | null, trace: string) => void
type VueErrorHandler = (error: unknown, instance: ComponentPublicInstance | null, info: string) => void

/** Nuxt marks the `errorHandler` it installs before plugins run, so it can drop it again. */
interface NuxtDefaultErrorHandler extends VueErrorHandler {
  __nuxt_default?: boolean
}

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

type OverlayEdge = 'top' | 'right' | 'bottom' | 'left'

interface OverlayPosition {
  _tag: OverlayEdge
  offset: number
}

type DragState
  = | { _tag: 'idle' }
    | { _tag: 'pending', pointerId: number, startX: number, startY: number, offsetX: number, offsetY: number }
    | { _tag: 'dragging', pointerId: number, offsetX: number, offsetY: number }

interface Point {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

const OVERLAY_MARGIN = 12
const PANEL_GAP = 8
const DRAG_THRESHOLD = 4
const SNAP_THRESHOLD = 2
const POSITION_STORAGE_KEY = 'nuxt-dx:overlay-position'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function snapOffset(value: number): number {
  if (value < 5)
    return 0
  if (value > 95)
    return 100
  if (Math.abs(value - 50) < SNAP_THRESHOLD)
    return 50
  return value
}

function overlayPositionFromPoint(point: Point, viewport: Size): OverlayPosition {
  const centerX = viewport.width / 2
  const centerY = viewport.height / 2
  const angle = Math.atan2(point.y - centerY, point.x - centerX)
  const horizontalMargin = 70
  const topLeft = Math.atan2(-centerY + horizontalMargin, -centerX)
  const topRight = Math.atan2(-centerY + horizontalMargin, viewport.width - centerX)
  const bottomLeft = Math.atan2(viewport.height - horizontalMargin - centerY, -centerX)
  const bottomRight = Math.atan2(viewport.height - horizontalMargin - centerY, viewport.width - centerX)
  const edge: OverlayEdge = angle >= topLeft && angle <= topRight
    ? 'top'
    : angle >= topRight && angle <= bottomRight
      ? 'right'
      : angle >= bottomRight && angle <= bottomLeft
        ? 'bottom'
        : 'left'
  const axisValue = edge === 'top' || edge === 'bottom'
    ? point.x / viewport.width
    : point.y / viewport.height

  return { _tag: edge, offset: snapOffset(clamp(axisValue * 100, 0, 100)) }
}

function defaultOverlayPosition(position: DxConfig['position']): OverlayPosition {
  return { _tag: 'bottom', offset: position === 'bottom-left' ? 0 : 100 }
}

function parseOverlayPosition(raw: string): OverlayPosition {
  const value: unknown = JSON.parse(raw)
  if (
    typeof value === 'object'
    && value !== null
    && '_tag' in value
    && ['top', 'right', 'bottom', 'left'].includes(String(value._tag))
    && 'offset' in value
    && typeof value.offset === 'number'
    && Number.isFinite(value.offset)
  ) {
    return { _tag: value._tag as OverlayEdge, offset: clamp(value.offset, 0, 100) }
  }
  throw new Error('Saved Nuxt DX overlay position is invalid.')
}

function overlayAnchor(position: OverlayPosition, viewport: Size, trigger: Size): Point {
  const halfWidth = trigger.width / 2
  const halfHeight = trigger.height / 2
  const horizontal = clamp(position.offset / 100 * viewport.width, OVERLAY_MARGIN + halfWidth, viewport.width - OVERLAY_MARGIN - halfWidth)
  const vertical = clamp(position.offset / 100 * viewport.height, OVERLAY_MARGIN + halfHeight, viewport.height - OVERLAY_MARGIN - halfHeight)

  switch (position._tag) {
    case 'top':
      return { x: horizontal, y: OVERLAY_MARGIN + halfHeight }
    case 'right':
      return { x: viewport.width - OVERLAY_MARGIN - halfWidth, y: vertical }
    case 'bottom':
      return { x: horizontal, y: viewport.height - OVERLAY_MARGIN - halfHeight }
    case 'left':
      return { x: OVERLAY_MARGIN + halfWidth, y: vertical }
  }
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
  inset: 0 auto auto 0;
  inline-size: 0;
  block-size: 0;
  color-scheme: dark;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
}

*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; }

.trigger {
  position: absolute;
  z-index: 1;
  inset: 0 auto auto 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-inline-size: 2.5rem;
  min-block-size: 2.5rem;
  max-inline-size: calc(100vw - 1.5rem);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--dx-success-border);
  border-radius: 999px;
  background: var(--dx-surface);
  color: var(--dx-text);
  box-shadow: 0 0.5rem 1.75rem rgb(0 0 0 / 28%);
  backdrop-filter: blur(0.75rem);
  cursor: grab;
  touch-action: none;
  user-select: none;
  transform: translate(-50%, -50%);
  transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
}

.trigger:hover { background: var(--dx-surface-hover); }
.trigger:active { transform: translate(-50%, -50%) scale(0.97); }
:host([data-dragging]) .trigger { cursor: grabbing; transition: none; }
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
.summary[hidden] { display: none; }
.summary-compact { display: none; }

.panel {
  position: absolute;
  display: flex;
  flex-direction: column;
  inline-size: min(30rem, calc(100dvw - 1.5rem));
  max-block-size: min(34rem, calc(100dvh - 5rem));
  overflow: hidden;
  border: 1px solid var(--dx-border-strong);
  border-radius: 1rem;
  background: var(--dx-bg);
  color: var(--dx-text);
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 42%);
  backdrop-filter: blur(1rem);
  animation: dx-enter 140ms ease-out;
}

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
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: scale(1); }
}

@media (max-width: 40rem) {
  .trigger { min-inline-size: 2.75rem; }
  .trigger, .action, .close { min-block-size: 2.75rem; }
  .summary-full { display: none; }
  .summary-compact:not([hidden]) { display: inline; }
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
    const runtimeScope = effectScope()
    const persistedPosition = runtimeScope.run(() => useStorage<OverlayPosition>(
      POSITION_STORAGE_KEY,
      defaultOverlayPosition(config.position),
      undefined,
      {
        deep: false,
        flush: 'sync',
        listenToStorageChanges: false,
        shallow: true,
        writeDefaults: false,
        serializer: {
          read: parseOverlayPosition,
          write: value => JSON.stringify(value),
        },
        onError: error => console.warn('[nuxt-dx] Ignored the saved overlay position.', error),
      },
    ))!
    let position = persistedPosition.value

    const host = document.createElement('div')
    host.dataset.nuxtDxOverlay = ''
    host.dataset.edge = position._tag
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
    const summary = element('span', 'summary summary-full')
    const compactSummary = element('span', 'summary summary-compact')
    summary.hidden = true
    compactSummary.hidden = true
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
    let dragState: DragState = { _tag: 'idle' }
    let suppressClickUntil = 0

    const viewportSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight })
    const alignPanel = (anchor: Point, trigger: Size) => {
      if (panel.hidden)
        return

      const viewport = viewportSize()
      const availableWidth = position._tag === 'top' || position._tag === 'bottom'
        ? viewport.width - OVERLAY_MARGIN * 2
        : viewport.width - OVERLAY_MARGIN * 2 - trigger.width - PANEL_GAP
      panel.style.inlineSize = `${Math.min(480, availableWidth)}px`
      const panelSize = { width: panel.offsetWidth, height: panel.offsetHeight }
      const naturalLeft = position._tag === 'left'
        ? anchor.x + trigger.width / 2 + PANEL_GAP
        : position._tag === 'right'
          ? anchor.x - trigger.width / 2 - PANEL_GAP - panelSize.width
          : anchor.x - panelSize.width / 2
      const naturalTop = position._tag === 'top'
        ? anchor.y + trigger.height / 2 + PANEL_GAP
        : position._tag === 'bottom'
          ? anchor.y - trigger.height / 2 - PANEL_GAP - panelSize.height
          : anchor.y - panelSize.height / 2
      const left = clamp(naturalLeft, OVERLAY_MARGIN, viewport.width - OVERLAY_MARGIN - panelSize.width)
      const top = clamp(naturalTop, OVERLAY_MARGIN, viewport.height - OVERLAY_MARGIN - panelSize.height)
      const originX = position._tag === 'left' ? 0 : position._tag === 'right' ? panelSize.width : clamp(anchor.x - left, 0, panelSize.width)
      const originY = position._tag === 'top' ? 0 : position._tag === 'bottom' ? panelSize.height : clamp(anchor.y - top, 0, panelSize.height)

      panel.style.left = `${left - anchor.x}px`
      panel.style.top = `${top - anchor.y}px`
      panel.style.transformOrigin = `${originX}px ${originY}px`
    }

    const applyPosition = () => {
      const trigger = { width: badge.offsetWidth, height: badge.offsetHeight }
      const anchor = overlayAnchor(position, viewportSize(), trigger)
      host.dataset.edge = position._tag
      host.style.left = `${anchor.x}px`
      host.style.top = `${anchor.y}px`
      alignPanel(anchor, trigger)
    }

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

      summary.textContent = counts.join(' · ')
      compactSummary.textContent = issues.length ? issueCountLabel(issues.length) : ''
      summary.hidden = issues.length === 0
      compactSummary.hidden = issues.length === 0
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
      applyPosition()
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
      applyPosition()
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
    const vueConfig = nuxtApp.vueApp.config

    /**
     * Both handlers record the issue and then hand it on. Whoever held the slot decides what
     * reaches the console, and Vue logs the warning itself when nobody does, so this logs only
     * when there is nothing behind it. An app that suppresses a warning keeps a quiet console
     * and still sees the issue in the overlay.
     */
    const warnChain = chainHandler<VueWarnHandler>(
      { read: () => vueConfig.warnHandler, write: (handler) => { vueConfig.warnHandler = handler } },
      (next, message, instance, trace) => {
        const mismatch = parseHydrationWarning(message.trim())
        if (mismatch) {
          const chain = parseComponentTrace(trace)
          const issue: DiagnosticIssue = { kind: 'hydration', mismatch, component: chain[0], componentFile: sourceFile(instance), trace: chain }
          addIssue(issue)
          if (next)
            next(message, instance, trace)
          else
            console.warn(`[nuxt-dx] ${formatIssueLine(issue)}`)
          return
        }
        const formatted = `${message.trim()}${sourceDetails(instance)}`
        addIssue({ kind: 'warning', message: formatted })
        if (next)
          next(message, instance, trace)
        else
          console.warn(`[Vue warn]: ${formatted}`)
      },
    )
    const errorChain = chainHandler<VueErrorHandler>(
      { read: () => vueConfig.errorHandler, write: (handler) => { vueConfig.errorHandler = handler } },
      (next, error, instance, info) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error)
        const formatted = `${info}: ${message}${sourceDetails(instance)}`
        addIssue({ kind: 'error', message: formatted })
        if (next)
          next(error, instance, info)
        else
          originalConsoleError(`[Vue error]: ${formatted}`)
      },
    )

    /**
     * This plugin runs first, so every plugin after it can take the slot and leave the overlay
     * blind. `app:created` fires once every plugin has run, which is the first moment where
     * taking the slot back cannot be undone by another plugin.
     */
    const removeCreatedHook = nuxtApp.hook('app:created', () => {
      warnChain.reinstall()
      errorChain.reinstall()
    })
    /**
     * Nuxt installs its own `errorHandler` before any plugin, and drops it once the app has
     * resolved, but only while it still holds the slot. This chain holds the slot instead, so
     * it drops that handler on Nuxt's behalf. Without this, every error after hydration would
     * reach Nuxt's startup handler and turn into the error page.
     */
    const removeSuspenseHook = nuxtApp.hook('app:suspense:resolve', () => {
      if ((errorChain.next() as NuxtDefaultErrorHandler | undefined)?.__nuxt_default)
        errorChain.setNext(undefined)
    })

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
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0)
        return
      const rect = badge.getBoundingClientRect()
      dragState = {
        _tag: 'pending',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left - rect.width / 2,
        offsetY: event.clientY - rect.top - rect.height / 2,
      }
      badge.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (dragState._tag === 'idle' || event.pointerId !== dragState.pointerId)
        return
      if (dragState._tag === 'pending') {
        if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) < DRAG_THRESHOLD)
          return
        dragState = { _tag: 'dragging', pointerId: dragState.pointerId, offsetX: dragState.offsetX, offsetY: dragState.offsetY }
        host.dataset.dragging = ''
        setPanelOpen(false)
      }
      event.preventDefault()
      position = overlayPositionFromPoint({ x: event.clientX - dragState.offsetX, y: event.clientY - dragState.offsetY }, viewportSize())
      applyPosition()
    }
    const finishDrag = (event: PointerEvent) => {
      if (dragState._tag === 'idle' || event.pointerId !== dragState.pointerId)
        return
      const wasDragging = dragState._tag === 'dragging'
      dragState = { _tag: 'idle' }
      if (badge.hasPointerCapture(event.pointerId))
        badge.releasePointerCapture(event.pointerId)
      if (!wasDragging)
        return
      delete host.dataset.dragging
      suppressClickUntil = Date.now() + 400
      persistedPosition.value = position
      applyPosition()
    }

    runtimeScope.run(() => {
      useEventListener(window, 'error', onWindowError)
      useEventListener(window, 'unhandledrejection', onUnhandledRejection)
      useEventListener(window, 'keydown', onKeyDown)
      useEventListener(window, 'resize', applyPosition)
      useEventListener(window, 'pointermove', onPointerMove, { passive: false })
      useEventListener(window, 'pointerup', finishDrag)
      useEventListener(window, 'pointercancel', finishDrag)
      useEventListener(badge, 'pointerdown', onPointerDown)
      useEventListener(badge, 'click', () => {
        if (Date.now() < suppressClickUntil)
          return
        setPanelOpen(panel.hidden)
      })
      useEventListener(closeButton, 'click', () => setPanelOpen(false, true))
      useEventListener(clearButton, 'click', () => {
        issues.length = 0
        seen.clear()
        render()
      })
      useEventListener(copyButton, 'click', () => {
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
    })

    const cleanup = () => {
      runtimeScope.stop()
      removeIssueHook()
      if (copyResetTimer)
        clearTimeout(copyResetTimer)
      if (console.error === patchedConsoleError)
        console.error = originalConsoleError
      removeCreatedHook()
      removeSuspenseHook()
      warnChain.restore()
      errorChain.restore()
      host.remove()
    }
    import.meta.hot?.dispose(cleanup)
    render()
  },
})
