import type { WideEventRecord } from './index'

export type DevelopmentWideEventRecord = WideEventRecord & Record<string, string | number | boolean | null | undefined>

export function enrichDevelopmentWideEvent(record: WideEventRecord, error: unknown): DevelopmentWideEventRecord {
  if (typeof error !== 'object' || error === null)
    return record
  const input = error as Record<string, unknown>
  if (typeof input.name === 'string')
    record['error.name'] = input.name
  if (typeof input.message === 'string')
    record['error.message'] = input.message
  if (typeof input.stack === 'string')
    record['error.stack'] = input.stack
  return record
}
