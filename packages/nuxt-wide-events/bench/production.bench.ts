import { deepStrictEqual } from 'node:assert/strict'
import { createLogger, initLogger } from 'evlog'
import pino from 'pino'
import { afterAll, beforeAll, bench, describe } from 'vitest'
import { addWideEventFields, captureWideEventError, emitWideEvent, startWideEvent } from '../src/runtime/server/index'

const BENCH_OPTIONS = {
  time: 2_000,
  warmupIterations: 1_000,
  warmupTime: 500,
} satisfies NonNullable<Parameters<typeof bench>[2]>

const EVLOG_BENCH_OPTIONS = {
  ...BENCH_OPTIONS,
  setup: () => initEvlog(false),
} satisfies NonNullable<Parameters<typeof bench>[2]>

const EVLOG_REDACTION_BENCH_OPTIONS = {
  ...BENCH_OPTIONS,
  setup: () => initEvlog(true),
} satisfies NonNullable<Parameters<typeof bench>[2]>

const REQUEST_ID = 'req_abc123'
const STARTED_AT = 10
const ENDED_AT = 12.5
const TIMESTAMP = '2026-08-13T00:00:00.000Z'
const ERROR = Object.assign(new Error('Payment failed'), { statusCode: 503 })
let sink: unknown

afterAll(() => {
  if (sink === undefined)
    throw new Error('The benchmark sink was not written.')
})

type BenchFields = Record<string, boolean | null | number | string>

const fields1 = {
  userId: 'usr_abc123',
} as const satisfies BenchFields

const fields5 = {
  userId: 'usr_abc123',
  action: 'checkout',
  cartItemCount: 3,
  region: 'au-southeast-2',
  sessionId: 'sess_xyz789',
} as const satisfies BenchFields

const fields20 = {
  userId: 'usr_abc123',
  action: 'checkout',
  cartItemCount: 3,
  cartTotal: 9999,
  currency: 'AUD',
  region: 'au-southeast-2',
  sessionId: 'sess_xyz789',
  accountPlan: 'pro',
  accountAgeDays: 365,
  featureCheckoutV2: true,
  paymentMethod: 'card',
  paymentAttempt: 1,
  inventoryReserved: true,
  shippingCountry: 'AU',
  shippingPostcode: '3000',
  couponCode: null,
  retryCount: 0,
  queueDepth: 12,
  responseCached: false,
  experimentVariant: 'control',
} as const satisfies BenchFields

const FIELD_SCENARIOS = [
  { label: '0 fields', fields: {} },
  { label: '1 field', fields: fields1 },
  { label: '5 fields', fields: fields5 },
  { label: '20 fields', fields: fields20 },
] as const

const metadata = {
  timestamp: TIMESTAMP,
  service: 'bench',
  method: 'POST',
  path: '/api/checkout',
  status: 200,
  durationMs: ENDED_AT - STARTED_AT,
  requestId: REQUEST_ID,
} as const

const pinoLogger = pino({
  base: null,
  formatters: {
    level: label => ({ level: label }),
  },
  timestamp: false,
}, {
  write(message) {
    sink = message
  },
})

function initEvlog(redact: boolean): void {
  initLogger({
    env: { service: 'bench', environment: 'production' },
    pretty: false,
    redact,
    silent: true,
    _suppressDrainWarning: true,
  })
}

function request() {
  return {
    context: {} as Record<PropertyKey, unknown>,
    method: metadata.method,
    path: metadata.path,
  }
}

function buildWideEvent(fields: BenchFields) {
  const event = request()
  startWideEvent(event, REQUEST_ID, STARTED_AT)
  addWideEventFields(event, fields as never)
  return emitWideEvent(
    event,
    metadata.status,
    metadata.service,
    metadata.path,
    ENDED_AT,
    TIMESTAMP,
  )!
}

function buildRuntimeWideEvent() {
  const event = request()
  startWideEvent(event)
  addWideEventFields(event, fields5 as never)
  return emitWideEvent(event, metadata.status, metadata.service, metadata.path)!
}

function buildEvlogEvent(fields: BenchFields) {
  const log = createLogger({
    requestId: REQUEST_ID,
    method: metadata.method,
    path: metadata.path,
  })
  log.set(fields)
  return log.emit({ status: metadata.status })!
}

function buildRuntimeEvlogEvent() {
  const log = createLogger({
    requestId: crypto.randomUUID(),
    method: metadata.method,
    path: metadata.path,
  })
  log.set(fields5)
  return log.emit({ status: metadata.status })!
}

function buildRawEvent(fields: BenchFields) {
  return {
    ...metadata,
    level: 'info',
    ...fields,
  }
}

function buildRuntimeRawEvent() {
  const requestId = crypto.randomUUID()
  const startedAt = performance.now()
  const endedAt = performance.now()
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: metadata.service,
    method: metadata.method,
    path: metadata.path,
    status: metadata.status,
    durationMs: Math.max(0, endedAt - startedAt),
    requestId,
    ...fields5,
  }
}

function writePinoEvent(fields: BenchFields): void {
  pinoLogger.info({
    ...metadata,
    ...fields,
  })
}

function writeRuntimePinoEvent(): void {
  const requestId = crypto.randomUUID()
  const startedAt = performance.now()
  const endedAt = performance.now()
  pinoLogger.info({
    timestamp: new Date().toISOString(),
    service: metadata.service,
    method: metadata.method,
    path: metadata.path,
    status: metadata.status,
    durationMs: Math.max(0, endedAt - startedAt),
    requestId,
    ...fields5,
  })
}

function buildWideErrorEvent() {
  const event = request()
  startWideEvent(event, REQUEST_ID, STARTED_AT)
  addWideEventFields(event, fields5 as never)
  captureWideEventError(event, ERROR)
  return emitWideEvent(event, 500, metadata.service, metadata.path, ENDED_AT, TIMESTAMP)!
}

function buildEvlogErrorEvent() {
  const log = createLogger({
    requestId: REQUEST_ID,
    method: metadata.method,
    path: metadata.path,
  })
  log.set(fields5)
  log.error(ERROR)
  return log.emit({ status: ERROR.statusCode })!
}

function buildRawErrorEvent() {
  return {
    ...metadata,
    'level': 'error',
    'status': ERROR.statusCode,
    ...fields5,
  }
}

function writePinoErrorEvent(): void {
  pinoLogger.error({
    ...metadata,
    'status': ERROR.statusCode,
    ...fields5,
  })
}

beforeAll(() => {
  initEvlog(false)
  for (const scenario of FIELD_SCENARIOS) {
    const raw = buildRawEvent(scenario.fields)
    deepStrictEqual(buildWideEvent(scenario.fields), raw)
    writePinoEvent(scenario.fields)
    deepStrictEqual(JSON.parse(sink as string), raw)
  }

  const rawError = buildRawErrorEvent()
  deepStrictEqual(buildWideErrorEvent(), rawError)
  writePinoErrorEvent()
  deepStrictEqual(JSON.parse(sink as string), rawError)
})

for (const scenario of FIELD_SCENARIOS) {
  describe(`production lifecycle, ${scenario.label}, JSON serialization`, () => {
    bench('nuxt-wide-events', () => {
      sink = JSON.stringify(buildWideEvent(scenario.fields))
    }, BENCH_OPTIONS)
    bench('evlog 2.26.0, redaction disabled', () => {
      sink = JSON.stringify(buildEvlogEvent(scenario.fields))
    }, EVLOG_BENCH_OPTIONS)
    bench('evlog 2.26.0, runtime redaction enabled', () => {
      sink = JSON.stringify(buildEvlogEvent(scenario.fields))
    }, EVLOG_REDACTION_BENCH_OPTIONS)
    bench('pino 10.3.1, in-memory destination', () => {
      writePinoEvent(scenario.fields)
    }, BENCH_OPTIONS)
    bench('raw object plus JSON.stringify', () => {
      sink = JSON.stringify(buildRawEvent(scenario.fields))
    }, BENCH_OPTIONS)
  })
}

describe('production lifecycle, runtime clocks and request ID', () => {
  bench('nuxt-wide-events', () => {
    sink = JSON.stringify(buildRuntimeWideEvent())
  }, BENCH_OPTIONS)
  bench('evlog 2.26.0, redaction disabled', () => {
    sink = JSON.stringify(buildRuntimeEvlogEvent())
  }, EVLOG_BENCH_OPTIONS)
  bench('pino 10.3.1, in-memory destination', writeRuntimePinoEvent, BENCH_OPTIONS)
  bench('raw object plus JSON.stringify', () => {
    sink = JSON.stringify(buildRuntimeRawEvent())
  }, BENCH_OPTIONS)
})

describe('production error lifecycle, five fields, JSON serialization', () => {
  bench('nuxt-wide-events', () => {
    sink = JSON.stringify(buildWideErrorEvent())
  }, BENCH_OPTIONS)
  bench('evlog 2.26.0, redaction disabled', () => {
    sink = JSON.stringify(buildEvlogErrorEvent())
  }, EVLOG_BENCH_OPTIONS)
  bench('evlog 2.26.0, runtime redaction enabled', () => {
    sink = JSON.stringify(buildEvlogErrorEvent())
  }, EVLOG_REDACTION_BENCH_OPTIONS)
  bench('pino 10.3.1, in-memory destination', writePinoErrorEvent, BENCH_OPTIONS)
  bench('raw object plus JSON.stringify', () => {
    sink = JSON.stringify(buildRawErrorEvent())
  }, BENCH_OPTIONS)
})

describe('production lifecycle, five fields, no serialization', () => {
  bench('nuxt-wide-events', () => {
    sink = buildWideEvent(fields5)
  }, BENCH_OPTIONS)
  bench('evlog 2.26.0, redaction disabled', () => {
    sink = buildEvlogEvent(fields5)
  }, EVLOG_BENCH_OPTIONS)
  bench('evlog 2.26.0, runtime redaction enabled', () => {
    sink = buildEvlogEvent(fields5)
  }, EVLOG_REDACTION_BENCH_OPTIONS)
  bench('raw object construction', () => {
    sink = buildRawEvent(fields5)
  }, BENCH_OPTIONS)
})

describe('field collection, five fields, no emit', () => {
  bench('nuxt-wide-events', () => {
    const event = request()
    startWideEvent(event, REQUEST_ID, STARTED_AT)
    addWideEventFields(event, fields5 as never)
    sink = event
  }, BENCH_OPTIONS)

  bench('evlog 2.26.0, redaction disabled', () => {
    const log = createLogger({ requestId: REQUEST_ID })
    log.set(fields5)
    sink = log
  }, EVLOG_BENCH_OPTIONS)
})

describe('production burst, 100 serialized events', () => {
  bench('nuxt-wide-events', () => {
    let result = ''
    for (let index = 0; index < 100; index++)
      result = JSON.stringify(buildWideEvent(fields5))
    sink = result
  }, BENCH_OPTIONS)

  bench('evlog 2.26.0, redaction disabled', () => {
    let result = ''
    for (let index = 0; index < 100; index++)
      result = JSON.stringify(buildEvlogEvent(fields5))
    sink = result
  }, EVLOG_BENCH_OPTIONS)

  bench('evlog 2.26.0, runtime redaction enabled', () => {
    let result = ''
    for (let index = 0; index < 100; index++)
      result = JSON.stringify(buildEvlogEvent(fields5))
    sink = result
  }, EVLOG_REDACTION_BENCH_OPTIONS)

  bench('pino 10.3.1, in-memory destination', () => {
    for (let index = 0; index < 100; index++)
      writePinoEvent(fields5)
  }, BENCH_OPTIONS)

  bench('raw object plus JSON.stringify', () => {
    let result = ''
    for (let index = 0; index < 100; index++)
      result = JSON.stringify(buildRawEvent(fields5))
    sink = result
  }, BENCH_OPTIONS)
})
