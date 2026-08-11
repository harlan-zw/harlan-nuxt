import { describe, expect, it } from 'vitest'
import { applyCloudflareDefaults, diagnoseWranglerConfig } from '../src/wrangler'

describe('applyCloudflareDefaults', () => {
  it('adds the proven Nuxt SEO and gscdump baseline without replacing user sampling', () => {
    expect(applyCloudflareDefaults({
      compatibility_flags: ['global_fetch_strictly_public'],
      env: {
        production: { secrets: { required: ['PRODUCTION_ONLY_SECRET'] } },
      },
      observability: { logs: { head_sampling_rate: 0.25 } },
    }, {
      requiredSecrets: ['API_TOKEN'],
    })).toMatchObject({
      compatibility_flags: ['global_fetch_strictly_public', 'nodejs_compat'],
      env: {
        production: { secrets: { required: ['PRODUCTION_ONLY_SECRET', 'API_TOKEN'] } },
      },
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.25, invocation_logs: true },
        traces: { enabled: true, head_sampling_rate: 0.01 },
      },
      secrets: { required: ['API_TOKEN'] },
      upload_source_maps: true,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    })
  })

  it('preserves an explicit source-map opt-out', () => {
    expect(applyCloudflareDefaults({ upload_source_maps: false })).toMatchObject({ upload_source_maps: false })
  })
})

describe('diagnoseWranglerConfig', () => {
  it.each([true, false, ['/api/**']])('rejects every run_worker_first declaration: %j', (runWorkerFirst) => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: '.output/public', run_worker_first: runWorkerFirst },
      observability: { enabled: true },
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toContainEqual(expect.objectContaining({
      _tag: 'error',
      code: 'assets-worker-first',
    }))
  })

  it('reports secret-looking vars by key without exposing their values', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      vars: { API_TOKEN: 'never-print-this', PUBLIC_ORIGIN: 'https://example.com' },
      observability: { enabled: true },
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toContainEqual(expect.objectContaining({
      _tag: 'error',
      code: 'plaintext-secret-var',
      path: 'vars.API_TOKEN',
    }))
    expect(JSON.stringify(diagnostics)).not.toContain('never-print-this')
  })

  it('warns when compatibility date is older than the configured policy', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-01-01',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
    }, { now: new Date('2026-08-11T00:00:00Z'), compatibilityMaxAgeDays: 90 }))
      .toContainEqual(expect.objectContaining({ _tag: 'warning', code: 'stale-compatibility-date' }))
  })
})
