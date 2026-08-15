import type { WideEventRecord } from '../src/runtime/server/index'
import { afterAll, bench, describe } from 'vitest'
import { shouldEmitWideEvent } from '../src/runtime/server/production-policy'

const exclude = /^(?:\/api\/_nuxt_icon\/.*|\/api\/_content\/.*|\/api\/_mdc\/.*)$/
const sampling = { duration: 1000, info: 10, status: 400 }
const request: WideEventRecord = {
  durationMs: 10,
  level: 'info',
  method: 'GET',
  path: '/api/checkout',
  requestId: 'req_1',
  status: 200,
  timestamp: '2026-08-13T00:00:00.000Z',
}
const error = { ...request, level: 'error' as const, status: 404 }
let sink: boolean

afterAll(() => {
  if (sink === undefined)
    throw new Error('The benchmark sink was not written.')
})

describe('production request policy', () => {
  bench('default', () => {
    sink = true
  })

  bench('mdream policy, sampled request', () => {
    sink = !exclude.test(request.path!)
      && !exclude.test(request.path!)
      && shouldEmitWideEvent(request, sampling)
  })

  bench('mdream policy, status kept', () => {
    sink = !exclude.test(error.path!)
      && !exclude.test(error.path!)
      && shouldEmitWideEvent(error, sampling)
  })
})
