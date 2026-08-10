export interface DiagnosticIssue {
  kind: 'error' | 'warning'
  message: string
}

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

  for (const kind of ['error', 'warning'] as const) {
    const issues = input.issues.filter(issue => issue.kind === kind)
    if (!issues.length)
      continue
    lines.push('', `## ${kind === 'error' ? 'Errors' : 'Warnings'}`)
    issues.forEach((issue, index) => lines.push(`### ${index + 1}.`, issue.message, ''))
  }

  if (!input.issues.length)
    lines.push('', 'No issues detected.')
  return lines.join('\n').trimEnd()
}
