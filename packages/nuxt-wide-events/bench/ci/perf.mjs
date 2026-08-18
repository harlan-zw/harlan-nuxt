import { deepStrictEqual, ok } from 'node:assert/strict'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import v8 from 'node:v8'
import { resolve } from 'pathe'

if (typeof globalThis.gc !== 'function')
  throw new TypeError('Run with --expose-gc so allocation can be measured.')

const newSpace = v8.getHeapSpaceStatistics().find(space => space.space_name === 'new_space')
if (!newSpace || newSpace.space_size < 200 * 1024 * 1024)
  throw new TypeError('Pin the V8 semi-space to 256 MiB so allocation stays in new-space.')

const pullRequestDirectory = process.env.WIDE_EVENTS_PR_DIST ?? process.env.WIDE_EVENTS_PERF_DIST
const baseDirectory = process.env.WIDE_EVENTS_BASE_DIST
if (!pullRequestDirectory)
  throw new TypeError('Set WIDE_EVENTS_PR_DIST to the pull request CI build directory.')

const REQUEST_ID = 'req_ci_abc123'
const STARTED_AT = 10
const ENDED_AT = 12.5
const TIMESTAMP = '2026-08-13T00:00:00.000Z'
const ALLOCATION_BATCH_SIZE = 20_000
const error = new Error('CI fixture error')
let sink

function createFiveFields() {
  return {
    action: 'checkout',
    cartItemCount: 3,
    region: 'au-southeast-2',
    sessionId: 'sess_xyz789',
    userId: 'usr_abc123',
  }
}

function createTwentyFields() {
  return {
    accountAgeDays: 365,
    accountPlan: 'pro',
    action: 'checkout',
    cartItemCount: 3,
    cartTotal: 9999,
    couponCode: null,
    currency: 'AUD',
    experimentVariant: 'control',
    featureCheckoutV2: true,
    inventoryReserved: true,
    paymentAttempt: 1,
    paymentMethod: 'card',
    queueDepth: 12,
    region: 'au-southeast-2',
    responseCached: false,
    retryCount: 0,
    sessionId: 'sess_xyz789',
    shippingCountry: 'AU',
    shippingPostcode: '3000',
    userId: 'usr_abc123',
  }
}

function createLaterFields() {
  return {
    cacheHit: true,
    queueDepth: 12,
    retryCount: 0,
    shippingCountry: 'AU',
    tenantId: 'tenant_abc123',
  }
}

function forceGarbageCollection() {
  globalThis.gc()
  globalThis.gc()
}

function statistics(samples) {
  const mean = samples.reduce((total, sample) => total + sample, 0) / samples.length
  const variance = samples.reduce((total, sample) => total + (sample - mean) ** 2, 0) / (samples.length - 1)
  const standardError = Math.sqrt(variance) / Math.sqrt(samples.length)
  return { value: mean, rme: standardError * 1.96 / mean * 100 }
}

function runBatch(operation, batchSize) {
  for (let index = 0; index < batchSize; index++)
    sink = operation()
}

function cpuSample(operation, batchSize) {
  forceGarbageCollection()
  const startedAt = process.threadCpuUsage()
  runBatch(operation, batchSize)
  const usage = process.threadCpuUsage(startedAt)
  return (usage.user + usage.system) / 1_000 / batchSize
}

function measureCpu(baseOperation, pullRequestOperation, batchSize) {
  for (let index = 0; index < 2; index++) {
    if (baseOperation)
      runBatch(baseOperation, batchSize)
    runBatch(pullRequestOperation, batchSize)
  }

  const baseSamples = []
  const pullRequestSamples = []
  for (let repetition = 0; repetition < 12; repetition++) {
    if (baseOperation && repetition % 2 === 0) {
      baseSamples.push(cpuSample(baseOperation, batchSize))
      pullRequestSamples.push(cpuSample(pullRequestOperation, batchSize))
    }
    else {
      pullRequestSamples.push(cpuSample(pullRequestOperation, batchSize))
      if (baseOperation)
        baseSamples.push(cpuSample(baseOperation, batchSize))
    }
  }

  const pullRequest = statistics(pullRequestSamples)
  if (!baseOperation)
    return { base: undefined, pullRequest }

  const base = statistics(baseSamples)
  const ratios = pullRequestSamples.map((sample, index) => sample / baseSamples[index])
  return {
    base,
    pullRequest: { ...pullRequest, comparisonRme: statistics(ratios).rme },
  }
}

function allocationSample(operation) {
  forceGarbageCollection()
  const before = process.memoryUsage().heapUsed
  runBatch(operation, ALLOCATION_BATCH_SIZE)
  return (process.memoryUsage().heapUsed - before) / ALLOCATION_BATCH_SIZE
}

function measureAllocation(baseOperation, pullRequestOperation) {
  for (let index = 0; index < 3; index++) {
    if (baseOperation)
      runBatch(baseOperation, ALLOCATION_BATCH_SIZE)
    runBatch(pullRequestOperation, ALLOCATION_BATCH_SIZE)
  }

  const baseSamples = []
  const pullRequestSamples = []
  for (let repetition = 0; repetition < 9; repetition++) {
    if (baseOperation && repetition % 2 === 0) {
      baseSamples.push(allocationSample(baseOperation))
      pullRequestSamples.push(allocationSample(pullRequestOperation))
    }
    else {
      pullRequestSamples.push(allocationSample(pullRequestOperation))
      if (baseOperation)
        baseSamples.push(allocationSample(baseOperation))
    }
  }
  return {
    base: baseOperation ? { value: Math.min(...baseSamples) } : undefined,
    pullRequest: { value: Math.min(...pullRequestSamples) },
  }
}

function createScenarios(runtime) {
  function fixedEvent(createFields, hasError = false) {
    const event = { context: {}, method: 'POST' }
    runtime.startWideEvent(event, REQUEST_ID, STARTED_AT)
    runtime.addWideEventFields(event, createFields(), true)
    if (hasError)
      runtime.captureWideEventError(event, error)
    return JSON.stringify(runtime.emitWideEvent(
      event,
      hasError ? 503 : 200,
      'ci',
      '/api/checkout',
      ENDED_AT,
      TIMESTAMP,
    ))
  }

  function runtimeEvent() {
    const event = { context: {}, method: 'POST' }
    runtime.startWideEvent(event)
    runtime.addWideEventFields(event, createFiveFields(), true)
    return JSON.stringify(runtime.emitWideEvent(event, 200, 'ci', '/api/checkout'))
  }

  function layeredEvent() {
    const event = { context: {}, method: 'POST' }
    runtime.startWideEvent(event, REQUEST_ID, STARTED_AT)
    runtime.addWideEventFields(event, createFiveFields(), true)
    runtime.addWideEventFields(event, createLaterFields(), true)
    return JSON.stringify(runtime.emitWideEvent(event, 200, 'ci', '/api/checkout', ENDED_AT, TIMESTAMP))
  }

  return [
    { id: 'five', name: 'Five Fields serialized', operation: () => fixedEvent(createFiveFields), cpuBatchSize: 1_500_000 },
    { id: 'twenty', name: 'Twenty Fields serialized', operation: () => fixedEvent(createTwentyFields), cpuBatchSize: 250_000 },
    { id: 'layered', name: 'Two Field layers serialized', operation: layeredEvent, cpuBatchSize: 700_000 },
    { id: 'runtime', name: 'Runtime clocks and request ID', operation: runtimeEvent, cpuBatchSize: 600_000 },
    { id: 'error', name: 'Error lifecycle', operation: () => fixedEvent(createFiveFields, true), cpuBatchSize: 1_200_000 },
  ]
}

async function loadRuntime(directory) {
  return import(pathToFileURL(resolve(directory, 'server-runtime.js')).href)
}

async function main() {
  const [baseRuntime, pullRequestRuntime] = await Promise.all([
    baseDirectory ? loadRuntime(baseDirectory) : undefined,
    loadRuntime(pullRequestDirectory),
  ])
  const baseScenarios = baseRuntime ? createScenarios(baseRuntime) : undefined
  const pullRequestScenarios = createScenarios(pullRequestRuntime)
  if (baseScenarios) {
    for (const [index, scenario] of pullRequestScenarios.entries())
      deepStrictEqual(normalizedOutput(scenario, scenario.operation()), normalizedOutput(scenario, baseScenarios[index].operation()))
  }
  const allocationOnly = process.argv.includes('--alloc-only')
  const baseBenches = []
  const pullRequestBenches = []

  for (const [index, scenario] of pullRequestScenarios.entries()) {
    const baseOperation = baseScenarios?.[index].operation
    const measurement = allocationOnly
      ? measureAllocation(baseOperation, scenario.operation)
      : measureCpu(baseOperation, scenario.operation, scenario.cpuBatchSize)
    const common = {
      id: `${scenario.id}-${allocationOnly ? 'alloc' : 'cpu'}`,
      kind: allocationOnly ? 'alloc' : 'time',
      name: `${scenario.name} ${allocationOnly ? 'allocation' : 'CPU'}`,
    }
    if (measurement.base)
      baseBenches.push({ ...common, ...measurement.base })
    pullRequestBenches.push({ ...common, ...measurement.pullRequest })
  }

  if (sink === undefined)
    throw new Error('The performance sink was not written.')
  process.stdout.write(`${JSON.stringify({
    base: baseBenches.length ? { benches: baseBenches } : null,
    pullRequest: { benches: pullRequestBenches },
  })}\n`)
}

/**
 * Fields this branch adds to every record on purpose.
 *
 * The parity guard checks that both runtimes do the same work, not that they emit the
 * same schema. A deliberate new field is dropped from both sides so the guard still
 * catches an accidental workload change. Remove an entry once the base runtime emits it.
 */
const INTENTIONAL_NEW_FIELDS = ['kind']

function normalizedOutput(scenario, output) {
  const record = JSON.parse(output)
  for (const field of INTENTIONAL_NEW_FIELDS)
    delete record[field]
  if (scenario.id !== 'runtime')
    return record
  ok(typeof record.durationMs === 'number')
  ok(typeof record.requestId === 'string')
  ok(typeof record.timestamp === 'string')
  return { ...record, durationMs: '<duration>', requestId: '<requestId>', timestamp: '<timestamp>' }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
