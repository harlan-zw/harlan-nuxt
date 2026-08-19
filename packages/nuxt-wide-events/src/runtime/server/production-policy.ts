import type { WideEventsRuntimeSampling } from '../../types'
import type { WideEventRecord } from './index'

export function shouldEmitWideEvent(
  record: WideEventRecord,
  sampling: WideEventsRuntimeSampling,
  random: () => number = Math.random,
): boolean {
  for (const condition of sampling.keep ?? []) {
    if (condition.duration !== undefined && record.durationMs < condition.duration)
      continue
    if (condition.status !== undefined && record.status < condition.status)
      continue
    return true
  }
  const rate = sampling[record.level] ?? 100
  if (rate <= 0)
    return false
  return rate >= 100 || random() * 100 < rate
}
