import type { WideEventRecord } from './index'

export function enrichDevelopmentWideEvent(record: WideEventRecord, error: unknown): WideEventRecord {
  if (typeof error !== 'object' || error === null)
    return record
  const input = error as Record<string, unknown>
  if (typeof input.message === 'string')
    record['error.message'] = input.message
  if (typeof input.stack === 'string')
    record['error.stack'] = input.stack
  return record
}
