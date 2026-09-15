import { expect, it } from 'vitest'
import { createInspectionReport, formatInspectionReport } from '../src/cli/inspect-report'

it('keeps errors and warnings when payload tracking is unavailable', () => {
  const report = createInspectionReport('http://localhost/', [
    { kind: 'error', message: 'Page failed' },
    { kind: 'warning', message: 'Missing prop' },
    { kind: 'error', message: 'Page failed' },
  ], { status: 'unavailable', reason: 'Disabled' })
  expect(report.diagnostics).toEqual([
    { kind: 'error', message: 'Page failed' },
    { kind: 'warning', message: 'Missing prop' },
  ])
  expect(formatInspectionReport(report)).toContain('Payload: Disabled')
})

it('combines hydration and payload diagnostics without duplicate warnings', () => {
  const report = createInspectionReport('http://localhost/', [
    { kind: 'hydration', mismatch: { kind: 'text', server: 'a', client: 'b' } },
  ], { status: 'complete', entries: [{ key: 'product', status: 'tracked', read: ['title'], unread: [{ key: 'details', bytes: 42 }] }] })
  const repeated = createInspectionReport(report.url, report.diagnostics, report.payload)
  expect(repeated.diagnostics).toEqual(report.diagnostics)
  expect(formatInspectionReport(report)).toContain('HYDRATION Text mismatch')
  expect(formatInspectionReport(report)).toContain('details')
})

it('makes incomplete observation visible even without errors', () => {
  const report = createInspectionReport('http://localhost/', [], { status: 'unavailable', reason: 'No module' }, 'No hydration signal')
  expect(report.status).toBe('partial')
  expect(formatInspectionReport(report)).toContain('Incomplete: No hydration signal')
})
