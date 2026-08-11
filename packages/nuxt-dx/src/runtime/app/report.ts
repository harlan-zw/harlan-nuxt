import type { HydrationMismatch } from './hydration'
import { hydrationMismatchLabel } from './hydration'

export interface HydrationIssue {
  kind: 'hydration'
  mismatch: HydrationMismatch
  /** The component Vue was hydrating, from the head of its warning trace. */
  component?: string
  /** That component's source file, relative to the configured source root. */
  componentFile?: string
  /** The component chain Vue reported, nearest first. */
  trace?: readonly string[]
}

export type DiagnosticIssue
  = | { kind: 'error', message: string }
    | { kind: 'warning', message: string }
    | HydrationIssue

export interface DiagnosticReportInput {
  url: string
  routeName: string
  pageComponent?: string
  issues: readonly DiagnosticIssue[]
}

export function relativeSourcePath(file: string, sourceRoot: string): string {
  const normalizedFile = file.replace(/\\/g, '/')
  const normalizedRoot = sourceRoot.replace(/\\/g, '/').replace(/\/$/, '')
  const prefix = `${normalizedRoot}/`
  return normalizedFile.startsWith(prefix) ? normalizedFile.slice(prefix.length) : normalizedFile
}

function hydrationHeading(issue: HydrationIssue): string {
  const label = hydrationMismatchLabel(issue.mismatch.kind)
  return issue.component ? `${label} in <${issue.component}>` : label
}

/**
 * The values differ on every render for the common `Date.now()` style mismatch, so the identity of
 * a hydration issue is where it happened rather than what it printed.
 */
export function issueSignature(issue: DiagnosticIssue): string {
  if (issue.kind !== 'hydration')
    return `${issue.kind}:${issue.message}`
  const { kind, element } = issue.mismatch
  return `hydration:${kind}:${issue.component ?? ''}:${issue.componentFile ?? ''}:${element ?? ''}`
}

/** The single-issue summary the overlay panel shows. */
export function formatIssueLine(issue: DiagnosticIssue): string {
  if (issue.kind === 'error')
    return `ERR ${issue.message}`
  if (issue.kind === 'warning')
    return `WARN ${issue.message}`

  const { server, client, detail, element } = issue.mismatch
  const lines = [`HYDRATION ${hydrationHeading(issue)}`]
  if (issue.componentFile)
    lines.push(`  file: ${issue.componentFile}`)
  if (element)
    lines.push(`  on: ${element}`)
  if (server !== undefined)
    lines.push(`  server: ${server}`)
  if (client !== undefined)
    lines.push(`  client: ${client}`)
  if (detail)
    lines.push(`  ${detail}`)
  return lines.join('\n')
}

function hydrationSection(issues: readonly HydrationIssue[]): string[] {
  const lines = [
    '',
    '## Hydration mismatches',
    '',
    'The server HTML and the first client render disagree. Make the two renders agree at the source; reach for `<ClientOnly>` or a mounted guard only when the value is genuinely client only.',
  ]
  issues.forEach((issue, index) => {
    const { server, client, detail, element } = issue.mismatch
    lines.push('', `### ${index + 1}. ${hydrationHeading(issue)}`)
    if (issue.componentFile)
      lines.push(`- Component file: \`${issue.componentFile}\``)
    if (issue.trace?.length)
      lines.push(`- Component chain: ${issue.trace.join(' < ')}`)
    if (element)
      lines.push(`- DOM node: \`${element}\``)
    if (server !== undefined)
      lines.push(`- Server rendered: \`${server}\``)
    if (client !== undefined)
      lines.push(`- Client rendered: \`${client}\``)
    if (detail)
      lines.push(`- Detail: ${detail}`)
  })
  lines.push('')
  return lines
}

export function formatDiagnosticReport(input: DiagnosticReportInput): string {
  const lines = [
    'Fix the following client-side issues on this page.',
    '',
    '## Context',
    `- URL: ${input.url}`,
    `- Route name: ${input.routeName}`,
  ]
  if (input.pageComponent)
    lines.push(`- Page component: ${input.pageComponent}`)

  const hydration = input.issues.filter((issue): issue is HydrationIssue => issue.kind === 'hydration')
  if (hydration.length)
    lines.push(...hydrationSection(hydration))

  for (const kind of ['error', 'warning'] as const) {
    const issues = input.issues.filter((issue): issue is Extract<DiagnosticIssue, { message: string }> => issue.kind === kind)
    if (!issues.length)
      continue
    lines.push('', `## ${kind === 'error' ? 'Errors' : 'Warnings'}`)
    issues.forEach((issue, index) => lines.push(`### ${index + 1}.`, issue.message, ''))
  }

  if (!input.issues.length)
    lines.push('', 'No issues detected.')
  return lines.join('\n').trimEnd()
}
