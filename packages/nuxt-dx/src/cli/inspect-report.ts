import type { PayloadUsageReport } from '../runtime/app/payload-usage'
import type { DiagnosticIssue } from '../runtime/app/report'
import { formatPayloadUsage } from '../runtime/app/payload-usage'
import { formatIssueLine, issueSignature } from '../runtime/app/report'

export type InspectionReport = {
  url: string
  diagnostics: DiagnosticIssue[]
  payload: PayloadUsageReport
} & ({ status: 'complete' } | { status: 'partial', reason: string })

export function createInspectionReport(url: string, diagnostics: DiagnosticIssue[], payload: PayloadUsageReport, reason?: string): InspectionReport {
  const entries = [...diagnostics]
  if (payload.status === 'complete') {
    for (const entry of payload.entries) {
      if (entry.status === 'tracked' && entry.unread.length)
        entries.push({ kind: 'warning', message: formatPayloadUsage(entry) })
    }
  }
  const unique = [...new Map(entries.map(entry => [issueSignature(entry), entry])).values()]
  const result = { url, diagnostics: unique, payload }
  return reason ? { ...result, status: 'partial', reason } : { ...result, status: 'complete' }
}

export function formatInspectionReport(report: InspectionReport): string {
  const lines = [`Nuxt DX: ${report.url}`, '']
  if (report.status === 'partial')
    lines.push(`Incomplete: ${report.reason}`, '')
  lines.push(...report.diagnostics.map(formatIssueLine))
  if (!report.diagnostics.length)
    lines.push('No client diagnostics recorded.')
  if (report.payload.status === 'unavailable')
    lines.push('', `Payload: ${report.payload.reason}`)
  return `${lines.join('\n')}\n`
}
