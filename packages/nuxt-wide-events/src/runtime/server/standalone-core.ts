import type { BackgroundWideEventRecord, WideEventFields, WideEventLevel, WideEventLike } from './index'
import { addWideEventFields, emitBackgroundWideEvent, setWideEventLevel, startWideEvent } from './index'

export interface BackgroundWideEvent extends WideEventLike {
  emit: () => BackgroundWideEventRecord | null
  setLevel: (level: WideEventLevel) => void
}

export interface DrainedBackgroundWideEvent extends WideEventLike {
  emit: () => Promise<BackgroundWideEventRecord | null>
  setLevel: (level: WideEventLevel) => void
}

interface BackgroundWideEventOptions {
  output?: (record: BackgroundWideEventRecord) => void
  sampling?: BackgroundWideEventSampling
  service?: string
}

interface DrainedBackgroundWideEventOptions extends BackgroundWideEventOptions {
  output: (record: BackgroundWideEventRecord) => Promise<void>
}

interface BackgroundWideEventSampling {
  debug?: number
  error?: number
  info?: number
  keep?: { duration?: number, status?: number }[]
  warn?: number
}

export function createBackgroundWideEvent(
  initialFields: WideEventFields | undefined,
  options: BackgroundWideEventOptions,
): BackgroundWideEvent {
  const event = { context: {} } as BackgroundWideEvent

  startWideEvent(event)
  if (initialFields)
    addWideEventFields(event, initialFields)

  event.setLevel = level => setWideEventLevel(event, level)
  event.emit = () => {
    const record = emitBackgroundWideEvent(event, options.service)
    if (!record)
      return null
    if (options.sampling && !shouldEmitBackgroundWideEvent(record, options.sampling))
      return null
    options.output?.(record)
    return record
  }

  return event
}

export function createDrainedBackgroundWideEvent(
  initialFields: WideEventFields | undefined,
  options: DrainedBackgroundWideEventOptions,
): DrainedBackgroundWideEvent {
  const event = createBackgroundWideEvent(initialFields, {
    sampling: options.sampling,
    service: options.service,
  })
  const emit = event.emit
  event.emit = (() => {
    const record = emit()
    if (!record)
      return Promise.resolve(null)
    return options.output(record).then(() => record)
  }) as never
  return event as unknown as DrainedBackgroundWideEvent
}

function shouldEmitBackgroundWideEvent(
  record: BackgroundWideEventRecord,
  sampling: BackgroundWideEventSampling,
): boolean {
  // A background Wide Event has no status, so a status condition can never keep it.
  for (const condition of sampling.keep ?? []) {
    if (condition.status !== undefined)
      continue
    if (condition.duration === undefined || record.durationMs >= condition.duration)
      return true
  }
  const rate = sampling[record.level] ?? 100
  return rate > 0 && (rate >= 100 || Math.random() * 100 < rate)
}
