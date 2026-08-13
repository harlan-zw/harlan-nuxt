import process from 'node:process'
import { createLogger, initLogger } from 'evlog'
// The profiler measures the exact published runtime artifact.
// eslint-disable-next-line antfu/no-import-dist
import { addWideEventFields, emitWideEvent, startWideEvent } from '../dist/runtime/server/index.js'

const scenario = process.argv[2]
const iterations = Number(process.argv[3] ?? 5_000_000)
const fields = {
  userId: 'usr_abc123',
  action: 'checkout',
  cartItemCount: 3,
  region: 'au-southeast-2',
  sessionId: 'sess_xyz789',
}
let sink

initLogger({
  env: { environment: 'production', service: 'profile' },
  pretty: false,
  redact: false,
  silent: true,
  _suppressDrainWarning: true,
})

for (let iteration = 0; iteration < iterations; iteration++) {
  if (scenario === 'wide') {
    const event = { context: {}, method: 'POST' }
    startWideEvent(event)
    addWideEventFields(event, fields)
    sink = JSON.stringify(emitWideEvent(event, 200, 'profile', '/api/checkout'))
  }
  else if (scenario === 'evlog') {
    const log = createLogger({
      requestId: crypto.randomUUID(),
      method: 'POST',
      path: '/api/checkout',
    })
    log.set(fields)
    sink = JSON.stringify(log.emit({ status: 200 }))
  }
  else if (scenario === 'raw') {
    const requestId = crypto.randomUUID()
    const startedAt = performance.now()
    sink = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'profile',
      method: 'POST',
      path: '/api/checkout',
      status: 200,
      durationMs: Math.max(0, performance.now() - startedAt),
      requestId,
      ...fields,
    })
  }
  else {
    throw new Error(`Unknown profile scenario: ${scenario}`)
  }
}

if (sink === undefined)
  throw new Error('Profile sink was not written.')
