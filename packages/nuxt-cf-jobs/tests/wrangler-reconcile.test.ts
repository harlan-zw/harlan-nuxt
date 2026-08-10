import { describe, expect, it } from 'vitest'
import {
  buildQueueExpectations,
  enrichQueuesWithConsumerConfig,
  mergeWranglerSources,
  normalizeNitroQueues,
  reconcileQueues,
} from '../src/wrangler'

describe('enrichQueuesWithConsumerConfig', () => {
  const queues = { billing: { binding: 'Q_BILLING', queueName: 'nuxtseo-billing' }, crawl: 'Q_CRAWL' }
  const expectations = buildQueueExpectations(queues)

  it('fills maxConcurrency / maxBatchSize from the matching wrangler consumer', () => {
    const out = enrichQueuesWithConsumerConfig(queues, expectations, [
      { queue: 'nuxtseo-billing', maxConcurrency: 5, maxBatchSize: 10 },
      { queue: 'crawl', maxConcurrency: 2 },
    ])
    expect(out.billing).toMatchObject({ binding: 'Q_BILLING', maxConcurrency: 5, maxBatchSize: 10 })
    // a bare-string queue is upgraded to an object only when there's config to add
    expect(out.crawl).toMatchObject({ binding: 'Q_CRAWL', maxConcurrency: 2 })
  })

  it('never overrides a value the module option already declares', () => {
    const declared = { crawl: { binding: 'Q_CRAWL', maxConcurrency: 8 } }
    const out = enrichQueuesWithConsumerConfig(declared, buildQueueExpectations(declared), [
      { queue: 'crawl', maxConcurrency: 2, maxBatchSize: 10 },
    ])
    expect(out.crawl).toMatchObject({ maxConcurrency: 8, maxBatchSize: 10 }) // kept 8, filled batch
  })

  it('passes queues through unchanged when there is no consumer or no concurrency', () => {
    expect(enrichQueuesWithConsumerConfig(queues, expectations, []).crawl).toBe('Q_CRAWL')
    expect(enrichQueuesWithConsumerConfig(queues, expectations, [{ queue: 'crawl' }]).crawl).toBe('Q_CRAWL')
  })
})

describe('buildQueueExpectations', () => {
  it('treats a string value as the binding name and the logical key as the cf queue name', () => {
    expect(buildQueueExpectations({ 'sync-critical': 'SYNC_CRITICAL' })).toEqual([
      { logical: 'sync-critical', binding: 'SYNC_CRITICAL', cfQueueName: 'sync-critical', explicitQueueName: false },
    ])
  })

  it('honours an explicit queueName and flags it explicit', () => {
    expect(buildQueueExpectations({ webhook: { binding: 'WEBHOOK', queueName: 'wh-prod' } })).toEqual([
      { logical: 'webhook', binding: 'WEBHOOK', cfQueueName: 'wh-prod', explicitQueueName: true },
    ])
  })

  it('skips entries with no binding and tolerates undefined', () => {
    expect(buildQueueExpectations({ broken: {} })).toEqual([])
    expect(buildQueueExpectations(undefined)).toEqual([])
  })
})

describe('normalizeNitroQueues', () => {
  it('reads inline nitro.cloudflare.wrangler queues and camelCases consumer keys', () => {
    const result = normalizeNitroQueues({
      cloudflare: {
        wrangler: {
          queues: {
            producers: [{ binding: 'Q', queue: 'q-prod' }],
            consumers: [{ queue: 'q-prod', max_retries: 5, max_batch_size: 10 }],
          },
        },
      },
    })
    expect(result).toEqual({
      producers: [{ binding: 'Q', queue: 'q-prod' }],
      consumers: [{ queue: 'q-prod', maxRetries: 5, maxBatchSize: 10 }],
    })
  })

  it('falls back to nitro.cloudflare.deploy.configuration', () => {
    const result = normalizeNitroQueues({
      cloudflare: { deploy: { configuration: { queues: { producers: [{ binding: 'Q', queue: 'q' }] } } } },
    })
    expect(result?.producers).toEqual([{ binding: 'Q', queue: 'q' }])
  })

  it('returns undefined when nitro declares no queues', () => {
    expect(normalizeNitroQueues({})).toBeUndefined()
    expect(normalizeNitroQueues(undefined)).toBeUndefined()
  })
})

describe('mergeWranglerSources', () => {
  it('returns undefined when neither source exists', () => {
    expect(mergeWranglerSources(undefined, undefined, '/root')).toBeUndefined()
  })

  it('lets nitro entries win over file entries on the same key', () => {
    const file = { path: 'wrangler.toml', producers: [{ binding: 'Q', queue: 'old' }], consumers: [{ queue: 'old' }] }
    const merged = mergeWranglerSources(
      file,
      { producers: [{ binding: 'Q', queue: 'old' }], consumers: [{ queue: 'old', maxRetries: 9 }] },
      '/root',
    )
    expect(merged?.path).toBe('wrangler.toml')
    expect(merged?.consumers).toEqual([{ queue: 'old', maxRetries: 9 }])
  })

  it('labels the path with the nitro source when no file exists', () => {
    const merged = mergeWranglerSources(undefined, { producers: [{ binding: 'Q', queue: 'q' }], consumers: [] }, '/root')
    expect(merged?.path).toContain('nitro.cloudflare.deploy.configuration')
  })
})

describe('reconcileQueues', () => {
  it('flags a missing producer + consumer against an empty wrangler file', () => {
    const { issues, suggestedToml } = reconcileQueues({
      queues: { 'sync-critical': 'SYNC_CRITICAL' },
      fileWrangler: { path: 'wrangler.toml', producers: [], consumers: [] },
      fallbackPath: '/root',
    })
    expect(issues.map(i => i.reason).sort()).toEqual(['missing-consumer', 'missing-producer'])
    expect(suggestedToml).toContain('binding = "SYNC_CRITICAL"')
  })

  it('reports no issues when the merged config satisfies expectations', () => {
    const { issues } = reconcileQueues({
      queues: { 'sync-critical': 'SYNC_CRITICAL' },
      fileWrangler: {
        path: 'wrangler.toml',
        producers: [{ binding: 'SYNC_CRITICAL', queue: 'sync-critical' }],
        consumers: [{ queue: 'sync-critical' }],
      },
      fallbackPath: '/root',
    })
    expect(issues).toEqual([])
  })

  it('satisfies expectations from nitro-config queues alone (no wrangler file)', () => {
    const { issues, merged } = reconcileQueues({
      queues: { 'sync-critical': 'SYNC_CRITICAL' },
      nitroOptions: {
        cloudflare: {
          wrangler: {
            queues: {
              producers: [{ binding: 'SYNC_CRITICAL', queue: 'sync-critical' }],
              consumers: [{ queue: 'sync-critical' }],
            },
          },
        },
      },
      fallbackPath: '/root',
    })
    expect(merged).toBeDefined()
    expect(issues).toEqual([])
  })

  it('returns empty expectations (nothing to check) when no queues are declared', () => {
    expect(reconcileQueues({ queues: {}, fallbackPath: '/root' }).expectations).toEqual([])
  })
})
