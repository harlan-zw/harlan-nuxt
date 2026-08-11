import { describe, expect, it } from 'vitest'
import { applyCloudflareDefaults, diagnoseWranglerConfig } from '../src/wrangler'

describe('applyCloudflareDefaults', () => {
  it('samples routine Workers Logs at one percent by default', () => {
    expect(applyCloudflareDefaults({}).observability?.logs?.head_sampling_rate).toBe(0.01)
  })

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
      placement: { mode: 'smart' },
      secrets: { required: ['API_TOKEN'] },
      upload_source_maps: true,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    })
  })

  it.each([
    {
      name: 'Nuxt SEO',
      config: {
        ai: { binding: 'AI' },
        browser: { binding: 'BROWSER' },
        cache: { enabled: false },
        compatibility_date: '2026-08-11',
        preview_urls: false,
        send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['noreply@notify.nuxtseo.com'] }],
        vectorize: [{ binding: 'VECTORIZE', index_name: 'nuxtseo' }],
        workers_dev: false,
      },
    },
    {
      name: 'gscdump',
      config: {
        cache: { enabled: true },
        compatibility_date: '2026-08-11',
        preview_urls: false,
        send_email: [{ name: 'SEND_EMAIL', allowed_sender_addresses: ['health@notify.gscdump.com'] }],
        workers_dev: false,
      },
    },
  ])('normalizes the $name deployment baseline without product policy warnings', ({ config }) => {
    const effective = applyCloudflareDefaults(config)
    const diagnostics = diagnoseWranglerConfig(effective, {
      generated: true,
      now: new Date('2026-08-11T00:00:00Z'),
    })

    expect(effective.cache?.cross_version_cache).toBe(false)
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'email-binding-unrestricted' }),
      expect.objectContaining({ code: 'preview-urls-public' }),
      expect.objectContaining({ code: 'remote-binding-not-enabled' }),
      expect.objectContaining({ code: 'workers-cache-policy-implicit' }),
      expect.objectContaining({ code: 'workers-dev-enabled' }),
      expect.objectContaining({ code: 'workers-dev-implicit' }),
    ]))
  })

  it('preserves an explicit source-map opt-out', () => {
    expect(applyCloudflareDefaults({ upload_source_maps: false })).toMatchObject({ upload_source_maps: false })
  })

  it('preserves explicit placement over the smart default', () => {
    expect(applyCloudflareDefaults({ placement: { region: 'gcp:us-east4' } }).placement)
      .toEqual({ region: 'gcp:us-east4' })
  })

  it('preserves an authored Workers Caching policy', () => {
    expect(applyCloudflareDefaults({
      cache: { enabled: true, cross_version_cache: false },
    }).cache).toEqual({ enabled: true, cross_version_cache: false })
  })

  it('makes an authored Workers Caching deployment scope explicit', () => {
    expect(applyCloudflareDefaults({
      cache: { enabled: true },
    }).cache).toEqual({ enabled: true, cross_version_cache: false })
  })

  it('lets an explicit module policy replace authored Workers Caching config', () => {
    expect(applyCloudflareDefaults({
      cache: { enabled: true, cross_version_cache: true },
    }, {
      workersCache: { _tag: 'disabled' },
    }).cache).toEqual({ enabled: false, cross_version_cache: false })
  })

  it('applies the complete policy to named environments', () => {
    const config = applyCloudflareDefaults({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      env: {
        production: {
          compatibility_flags: ['global_fetch_strictly_public'],
          observability: { enabled: false },
          secrets: { required: ['PRODUCTION_ONLY_SECRET'] },
        },
      },
      observability: { enabled: true },
      secrets: { required: ['ROOT_ONLY_SECRET'] },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }, { requiredSecrets: ['MODULE_SECRET'] })

    expect(config.env?.production).toMatchObject({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['global_fetch_strictly_public', 'nodejs_compat'],
      observability: { enabled: false },
      secrets: { required: ['PRODUCTION_ONLY_SECRET', 'MODULE_SECRET'] },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    })
    expect(config.secrets?.required).toEqual(['ROOT_ONLY_SECRET', 'MODULE_SECRET'])
  })

  it('disables workers.dev only when a production route proves reachability', () => {
    expect(applyCloudflareDefaults({ routes: [{ pattern: 'example.com', custom_domain: true }] }))
      .toMatchObject({ workers_dev: false })
    expect(applyCloudflareDefaults({}).workers_dev).toBeUndefined()
  })

  it('does not create a version metadata binding that collides with an existing binding', () => {
    expect(applyCloudflareDefaults({ vars: { CF_VERSION_METADATA: 'occupied' } }).version_metadata)
      .toBeUndefined()
    expect(applyCloudflareDefaults({ ai: { binding: 'CF_VERSION_METADATA' } }).version_metadata)
      .toBeUndefined()
  })

  it.each([
    { send_email: [{ name: 'CF_VERSION_METADATA' }] },
    { ratelimits: [{ name: 'CF_VERSION_METADATA' }] },
    { worker_loaders: [{ binding: 'CF_VERSION_METADATA' }] },
    { vpc_services: [{ binding: 'CF_VERSION_METADATA' }] },
    { vpc_networks: [{ binding: 'CF_VERSION_METADATA' }] },
  ])('does not collide with current Cloudflare product bindings: %j', (binding) => {
    expect(applyCloudflareDefaults(binding).version_metadata).toBeUndefined()
  })

  it('warns when local development cannot faithfully simulate a binding', () => {
    const diagnostics = diagnoseWranglerConfig({
      ai: { binding: 'AI' },
      browser: { binding: 'BROWSER' },
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      images: { binding: 'IMAGES' },
      mtls_certificates: [{ binding: 'MTLS', certificate_id: 'certificate' }],
      observability: { enabled: true },
      vectorize: [{ binding: 'VECTORIZE', index_name: 'index' }],
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics.filter(diagnostic => diagnostic.code === 'remote-binding-not-enabled'))
      .toHaveLength(5)
  })

  it('does not apply local binding advice to a generated deployment config', () => {
    const diagnostics = diagnoseWranglerConfig({
      ai: { binding: 'AI' },
      browser: { binding: 'BROWSER' },
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      vectorize: [{ binding: 'VECTORIZE', index_name: 'index' }],
      workers_dev: false,
    }, { generated: true, now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'remote-binding-not-enabled',
    }))
  })

  it.each(['wasm_modules', 'text_blobs', 'data_blobs'])(
    'does not collide with a record-key binding in %s',
    (category) => {
      expect(applyCloudflareDefaults({
        [category]: { CF_VERSION_METADATA: './binding.bin' },
      }).version_metadata).toBeUndefined()
    },
  )

  it('isolates version metadata collisions between root and named environments', () => {
    const childCollision = applyCloudflareDefaults({
      env: { production: { ai: { binding: 'CF_VERSION_METADATA' } } },
    })
    expect(childCollision.version_metadata).toEqual({ binding: 'CF_VERSION_METADATA' })
    expect(childCollision.env?.production?.version_metadata).toBeUndefined()

    const rootCollision = applyCloudflareDefaults({
      ai: { binding: 'CF_VERSION_METADATA' },
      env: { production: {} },
    })
    expect(rootCollision.version_metadata).toBeUndefined()
    expect(rootCollision.env?.production?.version_metadata).toEqual({ binding: 'CF_VERSION_METADATA' })
  })
})

describe('diagnoseWranglerConfig', () => {
  it('warns when log sampling exceeds the routine one-percent budget', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.1 },
        traces: { enabled: true, head_sampling_rate: 0.01 },
      },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'observability-log-sampling-high',
      }))
  })

  it('warns when trace sampling exceeds the routine one-percent budget', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.01 },
        traces: { enabled: true, head_sampling_rate: 0.1 },
      },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'observability-trace-sampling-high',
      }))
  })

  it('warns when Workers Caching makes static asset requests billable', () => {
    expect(diagnoseWranglerConfig({
      assets: { directory: '.output/public' },
      cache: { enabled: true, cross_version_cache: false },
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'workers-cache-assets-billable',
      }))
  })

  it('warns when a raised CPU limit increases runaway-cost exposure', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      limits: { cpu_ms: 60_000 },
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'cpu-limit-raised',
      }))
  })

  it('warns when Workers Caching policy is implicit', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'workers-cache-policy-implicit',
      }))
  })

  it('warns when Workers Caching is shared across deployments', () => {
    expect(diagnoseWranglerConfig({
      cache: { enabled: true, cross_version_cache: true },
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'workers-cache-cross-version-enabled',
      }))
  })

  it('warns about blanket Worker-first asset routing', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: '.output/public', run_worker_first: true },
      observability: { enabled: true },
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toContainEqual(expect.objectContaining({
      _tag: 'warning',
      code: 'assets-worker-first',
    }))
  })

  it.each([false, ['/pro/_nuxt/*'], ['/api/*', '!/api/docs/*']])(
    'allows asset-first or selective Worker-first routing: %j',
    (runWorkerFirst) => {
      const diagnostics = diagnoseWranglerConfig({
        compatibility_date: '2026-08-11',
        compatibility_flags: ['nodejs_compat'],
        assets: { directory: '.output/public', run_worker_first: runWorkerFirst },
        observability: { enabled: true },
      }, { now: new Date('2026-08-11T00:00:00Z') })

      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        code: 'assets-worker-first',
      }))
    },
  )

  it.each([
    { label: 'missing leading slash', value: ['pro/_nuxt/*'] },
    { label: 'invalid exception', value: ['!api/docs/*'] },
    { label: 'empty pattern', value: [''] },
    { label: 'non-string pattern', value: [42] },
  ])(
    'rejects an invalid selective Worker-first route pattern: $label',
    ({ value: runWorkerFirst }) => {
      expect(diagnoseWranglerConfig({
        compatibility_date: '2026-08-11',
        compatibility_flags: ['nodejs_compat'],
        assets: { directory: '.output/public', run_worker_first: runWorkerFirst as string[] },
        observability: { enabled: true },
      }, { now: new Date('2026-08-11T00:00:00Z') }))
        .toContainEqual(expect.objectContaining({
          _tag: 'error',
          code: 'assets-worker-first-pattern-invalid',
        }))
    },
  )

  it('rejects an invalid non-array Worker-first value', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: '.output/public', run_worker_first: '/api/*' as never },
      observability: { enabled: true },
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'error',
        code: 'assets-worker-first-pattern-invalid',
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
      _tag: 'warning',
      code: 'plaintext-secret-var',
      configPath: 'vars.API_TOKEN',
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

  it('surfaces defaults that expose a routed production Worker or allow dashboard var drift', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      keep_vars: true,
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.1 },
        traces: { enabled: true, head_sampling_rate: 0.01 },
      },
      routes: [{ pattern: 'example.com', custom_domain: true }],
      upload_source_maps: true,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'keep-vars-enabled' }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'workers-dev-implicit' }))
  })

  it('surfaces trace, sampling, queue retry, and DLQ policy gaps', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      queues: { consumers: [{ queue: 'jobs', max_retries: 5 }] },
      upload_source_maps: true,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'traces-disabled' }),
      expect.objectContaining({ code: 'observability-sampling-implicit' }),
      expect.objectContaining({ code: 'queue-retries-above-policy' }),
      expect.objectContaining({ code: 'queue-dlq-missing' }),
    ]))
  })

  it.each([
    ['head_sampling_rate', { head_sampling_rate: 1.1 }],
    ['logs.head_sampling_rate', { logs: { head_sampling_rate: -0.1 } }],
    ['traces.head_sampling_rate', { traces: { enabled: true, head_sampling_rate: Number.NaN } }],
  ])('rejects an observability sampling rate outside 0..1 at %s', (_, observability) => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true, ...observability },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'error',
        code: 'observability-sampling-out-of-range',
      }))
  })

  it.each([-1, 1.5, 101])('rejects queue retry count outside the platform range: %s', (maxRetries) => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      queues: { consumers: [{ queue: 'jobs', max_retries: maxRetries }] },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'queue-retries-out-of-range' }))
  })

  it.each([-1, 1.5, 86_401])('rejects queue retry delay outside the platform range: %s', (retryDelay) => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      queues: { consumers: [{ queue: 'jobs', retry_delay: retryDelay }] },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'queue-retry-delay-out-of-range' }))
  })

  it('warns that explicitly enabled preview URLs are public and not logged', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      preview_urls: true,
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'warning', code: 'preview-urls-public' }))
  })

  it('defaults preview URLs off and preserves an explicit opt-in', () => {
    expect(applyCloudflareDefaults({}).preview_urls).toBe(false)
    expect(applyCloudflareDefaults({ preview_urls: true }).preview_urls).toBe(true)
  })

  it('does not require a second DLQ for a consumer draining a DLQ', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      queues: {
        consumers: [
          { queue: 'jobs', dead_letter_queue: 'jobs-dlq' },
          { queue: 'jobs-dlq' },
        ],
      },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'queue-dlq-missing',
      configPath: 'queues.consumers.1.dead_letter_queue',
    }))
  })

  it('rejects mixed Durable Object lifecycle models', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
      exports: { Room: { type: 'durable-object', storage: 'sqlite' } },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'durable-object-lifecycle-mixed' }))
  })

  it('rejects declarative Durable Object exports beside an empty legacy migration list', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      exports: { Room: { type: 'durable-object', storage: 'sqlite' } },
      migrations: [],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'durable-object-lifecycle-mixed' }))
  })

  it('does not suggest mutating an existing declarative legacy-KV namespace', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
      exports: { Room: { type: 'durable-object', storage: 'legacy-kv' } },
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).not.toContainEqual(expect.objectContaining({ _tag: 'error' }))
  })

  it.each(['deleted', 'renamed', 'transferred'])(
    'rejects a binding to an inactive declarative Durable Object state: %s',
    (state) => {
      expect(diagnoseWranglerConfig({
        compatibility_date: '2026-08-11',
        compatibility_flags: ['nodejs_compat'],
        durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
        exports: { Room: { type: 'durable-object', state } },
        observability: { enabled: true },
        workers_dev: false,
      }, { now: new Date('2026-08-11T00:00:00Z') }))
        .toContainEqual(expect.objectContaining({
          _tag: 'error',
          code: 'durable-object-binding-inactive',
        }))
    },
  )

  it('allows a binding to a live Durable Object expecting transfer', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
      exports: {
        Room: {
          type: 'durable-object',
          state: 'expecting-transfer',
          storage: 'sqlite',
          transfer_from: 'room-source',
        },
      },
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .not
      .toContainEqual(expect.objectContaining({ code: 'durable-object-binding-inactive' }))
  })

  it.each([
    { category: 'containers', config: { containers: [{ class_name: 'SiteContainer', image: './Dockerfile' }] } },
    { category: 'd1_databases', config: { d1_databases: [{ binding: 'DB', database_id: 'database' }] } },
    { category: 'kv_namespaces', config: { kv_namespaces: [{ binding: 'CACHE', id: 'root-cache' }] } },
    { category: 'queues', config: { queues: { consumers: [{ queue: 'JOBS' }] } } },
    { category: 'tail_consumers', config: { tail_consumers: [{ service: 'tail-worker' }] } },
  ])('warns when a named environment omits non-inherited $category config', ({ category, config }) => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      env: { production: {} },
      ...config,
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'environment-binding-missing',
        configPath: `env.production.${category}`,
      }))
  })

  it('rejects a Container without its matching SQLite Durable Object', () => {
    const base = {
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      containers: [{ class_name: 'SiteContainer', image: './Dockerfile' }],
      observability: { enabled: true },
      workers_dev: false,
    }

    expect(diagnoseWranglerConfig(base, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ code: 'container-durable-object-binding-missing' }))
    expect(diagnoseWranglerConfig({
      ...base,
      durable_objects: { bindings: [{ name: 'CONTAINER', class_name: 'SiteContainer' }] },
      migrations: [{ tag: 'v1', new_classes: ['SiteContainer'] }],
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ code: 'container-durable-object-not-sqlite' }))
  })

  it('warns when an email binding has no sender or destination restriction', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      send_email: [{ name: 'EMAIL' }],
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ code: 'email-binding-unrestricted' }))
  })

  it('surfaces deprecated and unsafe product configuration', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      containers: [{ class_name: 'Container', image: './Dockerfile', instance_type: 'dev' }],
      data_blobs: { DATA: './data.bin' },
      durable_objects: { bindings: [{ name: 'CONTAINER', class_name: 'Container' }] },
      exports: { Container: { type: 'durable-object', storage: 'sqlite' } },
      observability: { enabled: true },
      pipelines: [{ binding: 'PIPELINE', pipeline: 'legacy-name' }],
      unsafe_hello_world: [{ binding: 'UNSAFE' }],
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'container-instance-type-deprecated' }),
      expect.objectContaining({ code: 'legacy-module-binding' }),
      expect.objectContaining({ code: 'pipeline-binding-deprecated' }),
      expect.objectContaining({ _tag: 'error', code: 'unsafe-hello-world-binding' }),
    ]))
  })

  it('inherits root declarative Durable Object exports into named environments', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      env: {
        production: {
          durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
        },
      },
      exports: { Room: { type: 'durable-object', storage: 'sqlite' } },
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'durable-object-lifecycle-unmanaged',
      configPath: 'env.production.durable_objects.bindings',
    }))
  })

  it('rejects locally defined Durable Objects with no lifecycle declaration', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      durable_objects: {
        bindings: [
          { name: 'LOCAL', class_name: 'Local' },
          { name: 'REMOTE', class_name: 'Remote', script_name: 'remote-worker' },
        ],
      },
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'durable-object-lifecycle-unmanaged' }))
  })

  it('rejects a local Durable Object missing from a non-empty migration history', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      durable_objects: {
        bindings: [
          { name: 'OLD', class_name: 'Old' },
          { name: 'NEW', class_name: 'New' },
        ],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Old'] }],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'durable-object-lifecycle-unmanaged' }))
  })

  it('resolves root Durable Object migrations for named environments', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      env: {
        production: {
          durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
        },
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'durable-object-lifecycle-unmanaged',
      configPath: 'env.production.durable_objects.bindings',
    }))
  })

  it('tracks a transferred Durable Object as active migration history', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
      migrations: [{
        tag: 'v2',
        transferred_classes: [{ from: 'OldRoom', from_script: 'old-worker', to: 'Room' }],
      }],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'durable-object-lifecycle-unmanaged',
    }))
  })

  it('requires an explicit Node compatibility mode before the v2 compatibility date', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2024-09-22',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2024-09-22T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'nodejs-compat-version-implicit' }))

    expect(diagnoseWranglerConfig({
      compatibility_date: '2024-09-22',
      compatibility_flags: ['nodejs_compat', 'no_nodejs_compat_v2'],
      observability: { enabled: true },
      workers_dev: false,
    }, { now: new Date('2024-09-22T00:00:00Z') }))
      .not
      .toContainEqual(expect.objectContaining({ code: 'nodejs-compat-version-implicit' }))
  })

  it('rejects named environments left in a generated deployment config', () => {
    expect(diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      env: { production: {} },
      observability: { enabled: true },
      workers_dev: false,
    }, { generated: true, now: new Date('2026-08-11T00:00:00Z') }))
      .toContainEqual(expect.objectContaining({ _tag: 'error', code: 'generated-config-has-env' }))
  })

  it('audits the effective policy of named environments', () => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      env: {
        production: {
          compatibility_flags: ['global_fetch_strictly_public'],
          observability: { enabled: false },
        },
      },
      observability: { enabled: true },
      upload_source_maps: true,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toContainEqual(expect.objectContaining({
      _tag: 'error',
      code: 'missing-nodejs-compat',
      configPath: 'env.production.compatibility_flags',
    }))
    expect(diagnostics).toContainEqual(expect.objectContaining({
      _tag: 'warning',
      code: 'observability-disabled',
      configPath: 'env.production.observability.enabled',
    }))
    expect(diagnostics).toContainEqual(expect.objectContaining({
      _tag: 'warning',
      code: 'version-metadata-missing',
      configPath: 'env.production.version_metadata',
    }))
  })

  it.each([
    'DATABASE_URL',
    'ENCRYPTION_KEY',
    'COOKIE_SIGNING_KEY',
    'STRIPE_KEY',
  ])('rejects high-signal plaintext secret variable %s', (name) => {
    const diagnostics = diagnoseWranglerConfig({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      upload_source_maps: true,
      vars: { [name]: 'secret' },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }, { now: new Date('2026-08-11T00:00:00Z') })

    expect(diagnostics).toContainEqual(expect.objectContaining({
      _tag: 'warning',
      code: 'plaintext-secret-var',
      configPath: `vars.${name}`,
    }))
  })
})
