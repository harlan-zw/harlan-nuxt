import type { WideEventFields, WideEventLike, WideEventRecord } from './index'
import { addWideEventFields, emitWideEvent, startWideEvent } from './index'

export type StandaloneWideEventLevel = 'debug' | 'error' | 'info' | 'warn'

export interface StandaloneWideEventRecord extends Omit<WideEventRecord, 'level'> {
  level: StandaloneWideEventLevel
}

export interface StandaloneWideEvent extends WideEventLike {
  emit: () => StandaloneWideEventRecord | null
  setLevel: (level: StandaloneWideEventLevel) => void
}

export interface DrainedStandaloneWideEvent extends WideEventLike {
  emit: () => Promise<StandaloneWideEventRecord | null>
  setLevel: (level: StandaloneWideEventLevel) => void
}

interface StandaloneWideEventOptions {
  output?: (record: StandaloneWideEventRecord) => void
  sampling?: StandaloneWideEventSampling
  service?: string
}

interface DrainedStandaloneWideEventOptions extends StandaloneWideEventOptions {
  output: (record: StandaloneWideEventRecord) => Promise<void>
}

interface StandaloneWideEventSampling {
  debug?: number
  duration?: number
  error?: number
  info?: number
  status?: number
  warn?: number
}

export function createStandaloneWideEvent(
  initialFields: WideEventFields | undefined,
  options: StandaloneWideEventOptions,
): StandaloneWideEvent {
  const event = {
    context: {},
    method: 'UNKNOWN',
  } as StandaloneWideEvent
  let emitted = false
  let level: StandaloneWideEventLevel = 'info'

  startWideEvent(event)
  if (initialFields)
    addWideEventFields(event, initialFields)

  event.setLevel = (nextLevel) => {
    if (emitted)
      throw new Error('The Wide Event was already emitted.')
    level = parseLevel(nextLevel)
  }
  event.emit = () => {
    const record = emitWideEvent(event, 200, options.service)
    if (!record)
      return null
    emitted = true
    const output = record as StandaloneWideEventRecord
    output.level = level
    if (options.sampling && !shouldEmitStandaloneWideEvent(output, options.sampling))
      return null
    options.output?.(output)
    return output
  }

  return event
}

export function createDrainedStandaloneWideEvent(
  initialFields: WideEventFields | undefined,
  options: DrainedStandaloneWideEventOptions,
): DrainedStandaloneWideEvent {
  const event = createStandaloneWideEvent(initialFields, {
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
  return event as unknown as DrainedStandaloneWideEvent
}

function shouldEmitStandaloneWideEvent(
  record: StandaloneWideEventRecord,
  sampling: StandaloneWideEventSampling,
): boolean {
  if (sampling.duration !== undefined && Number(record.durationMs) >= sampling.duration)
    return true
  if (sampling.status !== undefined && Number(record.status) >= sampling.status)
    return true
  const rate = sampling[record.level] ?? 100
  return rate > 0 && (rate >= 100 || Math.random() * 100 < rate)
}

function parseLevel(input: StandaloneWideEventLevel): StandaloneWideEventLevel {
  switch (input) {
    case 'debug':
    case 'error':
    case 'info':
    case 'warn':
      return input
    default:
      throw new TypeError('Wide Event level must be debug, error, info, or warn.')
  }
}
