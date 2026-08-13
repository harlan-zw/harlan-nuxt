import type { WideEventsRuntimeSampling } from '../../types'
import type { WideEventRecord } from './index'

export function shouldEmitWideEvent(
  record: WideEventRecord,
  sampling: WideEventsRuntimeSampling,
  random: () => number = Math.random,
): boolean {
  if (sampling.duration !== undefined && record.durationMs >= sampling.duration)
    return true
  if (sampling.status !== undefined && record.status >= sampling.status)
    return true
  const rate = record.level === 'error' ? sampling.error ?? 100 : sampling.info ?? 100
  if (rate <= 0)
    return false
  return rate >= 100 || random() * 100 < rate
}
