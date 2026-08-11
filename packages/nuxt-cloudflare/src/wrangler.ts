import { readFile } from 'node:fs/promises'

export interface WranglerAssetsInput {
  directory?: string
  binding?: string
  run_worker_first?: boolean | string[]
}

export interface WranglerWorkersCacheInput {
  enabled: boolean
  cross_version_cache?: boolean
}

export type WranglerPlacementInput
  = | { mode: 'smart', host?: never, hostname?: never, region?: never }
    | { host: string, hostname?: never, mode?: never, region?: never }
    | { hostname: string, host?: never, mode?: never, region?: never }
    | { region: string, host?: never, hostname?: never, mode?: never }

export interface WranglerRemoteBindingInput extends Record<string, unknown> {
  binding?: string
  remote?: boolean
}

export interface WranglerContainerInput extends Record<string, unknown> {
  class_name?: string
  image?: string
  instance_type?: string | Record<string, unknown>
}

export type WorkersCachePolicy
  = | { _tag: 'disabled' }
    | { _tag: 'enabled', crossVersion: boolean }

export interface WranglerObservabilityInput {
  enabled?: boolean
  head_sampling_rate?: number
  logs?: {
    enabled?: boolean
    head_sampling_rate?: number
    invocation_logs?: boolean
  }
  traces?: {
    enabled?: boolean
    head_sampling_rate?: number
  }
}

export interface WranglerConfigInput extends Record<string, unknown> {
  ai?: WranglerRemoteBindingInput
  assets?: WranglerAssetsInput
  browser?: WranglerRemoteBindingInput
  cache?: WranglerWorkersCacheInput
  compatibility_date?: string
  compatibility_flags?: string[]
  containers?: WranglerContainerInput[]
  env?: Record<string, WranglerConfigInput>
  images?: WranglerRemoteBindingInput
  keep_vars?: boolean
  mtls_certificates?: WranglerRemoteBindingInput[]
  observability?: WranglerObservabilityInput
  placement?: WranglerPlacementInput
  preview_urls?: boolean
  queues?: {
    consumers?: Array<Record<string, unknown>>
    producers?: Array<Record<string, unknown>>
  }
  route?: string | Record<string, unknown>
  routes?: Array<string | Record<string, unknown>>
  secrets?: {
    required?: string[]
  }
  vectorize?: WranglerRemoteBindingInput[]
  upload_source_maps?: boolean
  vars?: Record<string, unknown>
  version_metadata?: {
    binding: string
  }
  workers_dev?: boolean
}

export interface CloudflareDefaultOptions {
  compatibilityDate?: string
  logsSampleRate?: number
  requiredSecrets?: readonly string[]
  tracesSampleRate?: number
  uploadSourceMaps?: boolean
  versionMetadataBinding?: string
  workersCache?: WorkersCachePolicy
}

export const WRANGLER_DIAGNOSTIC_CODES = [
  'assets-worker-first',
  'assets-worker-first-pattern-invalid',
  'compatibility-date-missing',
  'compatibility-date-invalid',
  'container-durable-object-binding-missing',
  'container-durable-object-not-sqlite',
  'container-instance-type-deprecated',
  'durable-object-binding-inactive',
  'durable-object-lifecycle-mixed',
  'durable-object-lifecycle-unmanaged',
  'email-binding-unrestricted',
  'environment-binding-missing',
  'generated-config-has-env',
  'keep-vars-enabled',
  'legacy-module-binding',
  'missing-nodejs-compat',
  'nodejs-compat-version-implicit',
  'observability-disabled',
  'observability-sampling-implicit',
  'observability-sampling-out-of-range',
  'plaintext-secret-var',
  'preview-urls-public',
  'pipeline-binding-deprecated',
  'queue-dlq-missing',
  'queue-retries-above-policy',
  'queue-retries-out-of-range',
  'queue-retry-delay-out-of-range',
  'secret-declared-as-var',
  'source-maps-disabled',
  'stale-compatibility-date',
  'traces-disabled',
  'remote-binding-not-enabled',
  'unsafe-hello-world-binding',
  'version-metadata-missing',
  'workers-dev-enabled',
  'workers-dev-implicit',
  'workers-cache-cross-version-enabled',
  'workers-cache-policy-implicit',
  'wrangler-config-shadowed',
  'wrangler-config-missing',
  'wrangler-config-unreadable',
  'wrangler-jsonc-preferred',
] as const

export type WranglerDiagnosticCode = typeof WRANGLER_DIAGNOSTIC_CODES[number]

export interface WranglerDiagnostic {
  _tag: 'error' | 'info' | 'warning'
  code: WranglerDiagnosticCode
  message: string
  configPath?: string
  sourcePath?: string
}

export interface WranglerDiagnosticOptions {
  compatibilityMaxAgeDays?: number
  generated?: boolean
  now?: Date
  normalized?: boolean
  publicVarNames?: readonly string[]
  requireNodeCompat?: boolean
}

export type WranglerJsonFileResult
  = | { _tag: 'loaded', config: WranglerConfigInput, path: string }
    | { _tag: 'missing', path: string }
    | { _tag: 'invalid', path: string, reason: string }

const SECRET_NAME_RE = /(?:^|_)(?:API_?KEY|AUTH_TOKEN|CLIENT_SECRET|CREDENTIALS?|DATABASE_URL|DB_URL|ENCRYPTION_KEY|KEY|PASSWORD|PRIVATE_KEY|SECRET|SIGNING_KEY|TOKEN)(?:_|$)/i
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const NODEJS_COMPAT_V2_DATE = new Date('2024-09-23T00:00:00.000Z')

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseDateOnly(value: string): Date | undefined {
  if (!DATE_ONLY_RE.test(value))
    return undefined
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date
}

function parsedCompatibilityDateBeforeV2(value: string | undefined): boolean {
  const parsed = value && parseDateOnly(value)
  return Boolean(parsed && parsed < NODEJS_COMPAT_V2_DATE)
}

function resolveWorkersCachePolicy(policy: WorkersCachePolicy): WranglerWorkersCacheInput {
  if (policy._tag === 'disabled')
    return { enabled: false, cross_version_cache: false }
  return { enabled: true, cross_version_cache: policy.crossVersion }
}

const WRANGLER_BINDING_CATEGORIES = [
  'data_blobs',
  'durable_objects',
  'kv_namespaces',
  'send_email',
  'd1_databases',
  'vectorize',
  'ai_search_namespaces',
  'ai_search',
  'websearch',
  'agent_memory',
  'hyperdrive',
  'r2_buckets',
  'logfwdr',
  'services',
  'analytics_engine_datasets',
  'text_blobs',
  'browser',
  'ai',
  'images',
  'stream',
  'media',
  'version_metadata',
  'unsafe',
  'vars',
  'wasm_modules',
  'dispatch_namespaces',
  'mtls_certificates',
  'workflows',
  'pipelines',
  'secrets_store_secrets',
  'artifacts',
  'ratelimits',
  'worker_loaders',
  'vpc_services',
  'vpc_networks',
  'assets',
  'unsafe_hello_world',
  'flagship',
] as const

const WRANGLER_RECORD_BINDING_CATEGORIES = new Set<string>([
  'cloudchamber',
  'data_blobs',
  'define',
  'text_blobs',
  'vars',
  'wasm_modules',
])

const WRANGLER_NON_INHERITED_BINDING_CATEGORIES = [
  'agent_memory',
  'ai',
  'ai_search',
  'ai_search_namespaces',
  'analytics_engine_datasets',
  'artifacts',
  'browser',
  'cloudchamber',
  'containers',
  'd1_databases',
  'data_blobs',
  'define',
  'dispatch_namespaces',
  'durable_objects',
  'flagship',
  'hyperdrive',
  'images',
  'kv_namespaces',
  'logfwdr',
  'media',
  'mtls_certificates',
  'pipelines',
  'queues',
  'r2_buckets',
  'ratelimits',
  'secrets',
  'secrets_store_secrets',
  'send_email',
  'services',
  'stream',
  'streaming_tail_consumers',
  'tail_consumers',
  'text_blobs',
  'unsafe',
  'unsafe_hello_world',
  'vars',
  'vectorize',
  'version_metadata',
  'vpc_networks',
  'vpc_services',
  'wasm_modules',
  'websearch',
  'worker_loaders',
  'workflows',
] as const

function addBindingNames(names: Set<string>, value: unknown, category?: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (!isRecord(entry))
        return
      if (typeof entry.binding === 'string')
        names.add(entry.binding)
      else if (typeof entry.name === 'string')
        names.add(entry.name)
      else if (category === 'containers' && typeof entry.class_name === 'string')
        names.add(entry.class_name)
      else if ((category === 'tail_consumers' || category === 'streaming_tail_consumers') && typeof entry.service === 'string')
        names.add(entry.service)
    })
    return
  }
  if (!isRecord(value))
    return
  if (Array.isArray(value.bindings)) {
    value.bindings.forEach((binding) => {
      if (isRecord(binding) && typeof binding.name === 'string')
        names.add(binding.name)
    })
    return
  }
  if (typeof value.binding === 'string') {
    names.add(value.binding)
    return
  }
  if (category && WRANGLER_RECORD_BINDING_CATEGORIES.has(category)) {
    Object.entries(value).forEach(([name, binding]) => {
      if (binding !== undefined)
        names.add(name)
    })
  }
}

function collectBindingNames(config: WranglerConfigInput): Set<string> {
  const names = new Set(config.secrets?.required ?? [])
  WRANGLER_BINDING_CATEGORIES.forEach(category => addBindingNames(names, config[category], category))
  addBindingNames(names, config.queues?.producers)
  return names
}

function collectCategoryBindingNames(config: WranglerConfigInput, category: string): Set<string> {
  if (category === 'secrets')
    return new Set(config.secrets?.required ?? [])
  const names = new Set<string>()
  if (category === 'queues') {
    addBindingNames(names, config.queues?.producers)
    config.queues?.consumers?.forEach((consumer) => {
      if (typeof consumer.queue === 'string')
        names.add(consumer.queue)
    })
  }
  else {
    addBindingNames(names, config[category], category)
  }
  return names
}

function configuredRemoteBindings(config: WranglerConfigInput): Array<{ path: string, value: Record<string, unknown> }> {
  const bindings: Array<{ path: string, value: Record<string, unknown> }> = []
  for (const category of ['ai', 'browser', 'images'] as const) {
    const value = config[category]
    if (isRecord(value) && typeof value.binding === 'string')
      bindings.push({ path: category, value })
  }
  for (const category of ['flagship', 'mtls_certificates', 'vectorize'] as const) {
    const value = config[category]
    if (!Array.isArray(value))
      continue
    value.forEach((entry, index) => {
      if (isRecord(entry) && typeof entry.binding === 'string')
        bindings.push({ path: `${category}.${index}`, value: entry })
    })
  }
  return bindings
}

export function applyCloudflareDefaults(
  config: WranglerConfigInput,
  options: CloudflareDefaultOptions = {},
): WranglerConfigInput {
  const root = applyEnvironmentDefaults(config, options)
  const environments = config.env && Object.fromEntries(
    Object.entries(config.env).map(([name, environment]) => [name, applyEnvironmentDefaults(environment, {
      ...options,
      requiredSecrets: options.requiredSecrets,
    }, root)]),
  )
  return environments ? { ...root, env: environments } : root
}

function applyEnvironmentDefaults(
  config: WranglerConfigInput,
  options: CloudflareDefaultOptions,
  inherited: WranglerConfigInput = {},
): WranglerConfigInput {
  const compatibilityDate = config.compatibility_date ?? inherited.compatibility_date ?? options.compatibilityDate
  const compatibilityFlags = unique([...(config.compatibility_flags ?? inherited.compatibility_flags ?? []), 'nodejs_compat'])
  const authoredCache = config.cache ?? inherited.cache
  const cache = options.workersCache
    ? resolveWorkersCachePolicy(options.workersCache)
    : authoredCache
      ? { ...authoredCache, cross_version_cache: authoredCache.cross_version_cache ?? false }
      : resolveWorkersCachePolicy({ _tag: 'disabled' })
  const requiredSecrets = unique([...(config.secrets?.required ?? []), ...(options.requiredSecrets ?? [])])
  const logs = config.observability?.logs
  const inheritedLogs = inherited.observability?.logs
  const traces = config.observability?.traces
  const inheritedTraces = inherited.observability?.traces
  const uploadSourceMaps = config.upload_source_maps ?? inherited.upload_source_maps ?? options.uploadSourceMaps ?? true
  const previewUrls = config.preview_urls ?? inherited.preview_urls ?? false
  const placement = config.placement ?? inherited.placement ?? { mode: 'smart' }
  const workersDev = config.workers_dev
    ?? inherited.workers_dev
    ?? ((config.route !== undefined || (config.routes?.length ?? 0) > 0) ? false : undefined)
  const versionMetadataBinding = options.versionMetadataBinding ?? 'CF_VERSION_METADATA'
  const localBindingNames = collectBindingNames(config)
  const versionMetadata = config.version_metadata
    ?? (inherited.version_metadata && !localBindingNames.has(inherited.version_metadata.binding)
      ? inherited.version_metadata
      : undefined)
    ?? (localBindingNames.has(versionMetadataBinding) ? undefined : { binding: versionMetadataBinding })

  return {
    ...config,
    cache,
    ...(compatibilityDate === undefined ? {} : { compatibility_date: compatibilityDate }),
    compatibility_flags: compatibilityFlags,
    observability: {
      ...inherited.observability,
      ...config.observability,
      enabled: config.observability?.enabled ?? inherited.observability?.enabled ?? true,
      logs: {
        ...inheritedLogs,
        ...logs,
        enabled: logs?.enabled ?? inheritedLogs?.enabled ?? true,
        head_sampling_rate: logs?.head_sampling_rate ?? inheritedLogs?.head_sampling_rate ?? options.logsSampleRate ?? 0.1,
        invocation_logs: logs?.invocation_logs ?? inheritedLogs?.invocation_logs ?? true,
      },
      traces: {
        ...inheritedTraces,
        ...traces,
        enabled: traces?.enabled ?? inheritedTraces?.enabled ?? true,
        head_sampling_rate: traces?.head_sampling_rate ?? inheritedTraces?.head_sampling_rate ?? options.tracesSampleRate ?? 0.01,
      },
    },
    placement,
    ...(requiredSecrets.length > 0 ? { secrets: { ...config.secrets, required: requiredSecrets } } : {}),
    upload_source_maps: uploadSourceMaps,
    ...(versionMetadata ? { version_metadata: versionMetadata } : {}),
    preview_urls: previewUrls,
    ...(workersDev === undefined ? {} : { workers_dev: workersDev }),
  }
}

function diagnoseEnvironment(
  config: WranglerConfigInput,
  prefix: string,
  diagnostics: WranglerDiagnostic[],
  generated: boolean,
  normalized: boolean,
  publicVarNames: ReadonlySet<string>,
): void {
  const workerFirst: unknown = config.assets?.run_worker_first
  if (workerFirst === true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'assets-worker-first',
      message: 'Blanket Worker-first routing invokes the Worker for every asset. Use it only when authentication or response transforms require it.',
      configPath: `${prefix}assets.run_worker_first`,
    })
  }
  else if (Array.isArray(workerFirst)) {
    const invalidPatternIndex = workerFirst.findIndex(
      pattern => typeof pattern !== 'string' || !/^(?:!\/|\/)/.test(pattern),
    )
    if (invalidPatternIndex !== -1) {
      diagnostics.push({
        _tag: 'error',
        code: 'assets-worker-first-pattern-invalid',
        message: 'Selective Worker-first patterns must begin with / or !/.',
        configPath: `${prefix}assets.run_worker_first.${invalidPatternIndex}`,
      })
    }
  }
  else if (workerFirst !== undefined && workerFirst !== false) {
    diagnostics.push({
      _tag: 'error',
      code: 'assets-worker-first-pattern-invalid',
      message: 'assets.run_worker_first must be false or an array of route patterns.',
      configPath: `${prefix}assets.run_worker_first`,
    })
  }

  const durableObjectExports = isRecord(config.exports)
    ? Object.entries(config.exports).filter(([, value]) => isRecord(value) && value.type === 'durable-object')
    : []
  const migrations = Array.isArray(config.migrations) ? config.migrations : []
  const hasExports = normalized ? durableObjectExports.length > 0 : Object.hasOwn(config, 'exports')
  const hasMigrations = normalized ? migrations.length > 0 : Object.hasOwn(config, 'migrations')
  if (hasExports && hasMigrations) {
    diagnostics.push({
      _tag: 'error',
      code: 'durable-object-lifecycle-mixed',
      message: 'Durable Object declarative exports and legacy migrations are mutually exclusive.',
      configPath: `${prefix}exports`,
    })
  }
  const durableObjects = isRecord(config.durable_objects) ? config.durable_objects : undefined
  const bindings = Array.isArray(durableObjects?.bindings) ? durableObjects.bindings : []
  const localClassNames = bindings.flatMap((binding) => {
    if (!isRecord(binding) || typeof binding.script_name === 'string' || typeof binding.class_name !== 'string')
      return []
    return [binding.class_name]
  })
  const inactiveExportedClassNames = new Set(durableObjectExports.flatMap(([name, value]) => {
    if (!isRecord(value) || value.state === undefined || value.state === 'created' || value.state === 'expecting-transfer')
      return []
    return [name]
  }))
  if (localClassNames.some(className => inactiveExportedClassNames.has(className))) {
    diagnostics.push({
      _tag: 'error',
      code: 'durable-object-binding-inactive',
      message: 'A Durable Object binding may target only an active declarative export.',
      configPath: `${prefix}durable_objects.bindings`,
    })
  }
  const exportedClassNames = new Set(durableObjectExports.map(([name]) => name))
  const exportedClassStorage = new Map(durableObjectExports.flatMap(([name, value]) => {
    if (!isRecord(value) || (value.storage !== 'sqlite' && value.storage !== 'legacy-kv'))
      return []
    return [[name, value.storage] as const]
  }))
  const migratedClassNames = new Set<string>()
  const migratedClassStorage = new Map<string, 'legacy-kv' | 'sqlite'>()
  for (const migration of migrations) {
    if (!isRecord(migration))
      continue
    for (const key of ['new_classes', 'new_sqlite_classes'] as const) {
      if (Array.isArray(migration[key])) {
        for (const className of migration[key]) {
          if (typeof className === 'string') {
            migratedClassNames.add(className)
            migratedClassStorage.set(className, key === 'new_sqlite_classes' ? 'sqlite' : 'legacy-kv')
          }
        }
      }
    }
    if (Array.isArray(migration.renamed_classes)) {
      for (const rename of migration.renamed_classes) {
        if (!isRecord(rename))
          continue
        const storage = typeof rename.from === 'string' ? migratedClassStorage.get(rename.from) : undefined
        if (typeof rename.from === 'string') {
          migratedClassNames.delete(rename.from)
          migratedClassStorage.delete(rename.from)
        }
        if (typeof rename.to === 'string') {
          migratedClassNames.add(rename.to)
          if (storage)
            migratedClassStorage.set(rename.to, storage)
        }
      }
    }
    if (Array.isArray(migration.transferred_classes)) {
      for (const transfer of migration.transferred_classes) {
        if (isRecord(transfer) && typeof transfer.to === 'string')
          migratedClassNames.add(transfer.to)
      }
    }
    if (Array.isArray(migration.deleted_classes)) {
      for (const className of migration.deleted_classes) {
        if (typeof className === 'string') {
          migratedClassNames.delete(className)
          migratedClassStorage.delete(className)
        }
      }
    }
  }
  if (localClassNames.some(className => !exportedClassNames.has(className) && !migratedClassNames.has(className))) {
    diagnostics.push({
      _tag: 'error',
      code: 'durable-object-lifecycle-unmanaged',
      message: 'Every locally defined Durable Object needs a declarative export or a legacy migration history.',
      configPath: `${prefix}durable_objects.bindings`,
    })
  }

  for (const [index, container] of (config.containers ?? []).entries()) {
    if (typeof container.class_name !== 'string')
      continue
    const configPath = `${prefix}containers.${index}.class_name`
    if (!localClassNames.includes(container.class_name)) {
      diagnostics.push({
        _tag: 'error',
        code: 'container-durable-object-binding-missing',
        message: `Container class ${container.class_name} needs a matching local Durable Object binding.`,
        configPath,
      })
    }
    else if (exportedClassStorage.get(container.class_name) === 'legacy-kv'
      || migratedClassStorage.get(container.class_name) === 'legacy-kv') {
      diagnostics.push({
        _tag: 'error',
        code: 'container-durable-object-not-sqlite',
        message: `Container class ${container.class_name} needs SQLite Durable Object storage.`,
        configPath,
      })
    }
    if (container.instance_type === 'dev' || container.instance_type === 'standard') {
      diagnostics.push({
        _tag: 'warning',
        code: 'container-instance-type-deprecated',
        message: `Container instance type ${container.instance_type} is deprecated. Choose a current instance type.`,
        configPath: `${prefix}containers.${index}.instance_type`,
      })
    }
  }

  if (!generated) {
    for (const binding of configuredRemoteBindings(config)) {
      if (binding.value.remote === true)
        continue
      diagnostics.push({
        _tag: 'warning',
        code: 'remote-binding-not-enabled',
        message: 'Set remote to true when local development needs the real Cloudflare service.',
        configPath: `${prefix}${binding.path}.remote`,
      })
    }
  }

  if (Array.isArray(config.send_email)) {
    config.send_email.forEach((binding, index) => {
      if (!isRecord(binding))
        return
      const isRestricted = typeof binding.destination_address === 'string'
        || (Array.isArray(binding.allowed_destination_addresses) && binding.allowed_destination_addresses.length > 0)
        || (Array.isArray(binding.allowed_sender_addresses) && binding.allowed_sender_addresses.length > 0)
      if (!isRestricted) {
        diagnostics.push({
          _tag: 'warning',
          code: 'email-binding-unrestricted',
          message: 'Restrict this email binding to approved senders or destinations.',
          configPath: `${prefix}send_email.${index}`,
        })
      }
    })
  }

  if (Array.isArray(config.pipelines)) {
    config.pipelines.forEach((binding, index) => {
      if (isRecord(binding) && typeof binding.pipeline === 'string') {
        diagnostics.push({
          _tag: 'warning',
          code: 'pipeline-binding-deprecated',
          message: 'Replace the deprecated pipeline field with stream.',
          configPath: `${prefix}pipelines.${index}.pipeline`,
        })
      }
    })
  }

  for (const category of ['data_blobs', 'text_blobs', 'wasm_modules'] as const) {
    if (isRecord(config[category]) && Object.keys(config[category]).length > 0) {
      diagnostics.push({
        _tag: 'warning',
        code: 'legacy-module-binding',
        message: `Replace legacy ${category} bindings with module rules and imports.`,
        configPath: `${prefix}${category}`,
      })
    }
  }

  if (Array.isArray(config.unsafe_hello_world) && config.unsafe_hello_world.length > 0) {
    diagnostics.push({
      _tag: 'error',
      code: 'unsafe-hello-world-binding',
      message: 'Remove the explanatory unsafe_hello_world binding.',
      configPath: `${prefix}unsafe_hello_world`,
    })
  }

  const requiredSecrets = new Set(config.secrets?.required ?? [])
  for (const name of Object.keys(config.vars ?? {})) {
    const configPath = `${prefix}vars.${name}`
    if (requiredSecrets.has(name)) {
      diagnostics.push({
        _tag: 'error',
        code: 'secret-declared-as-var',
        message: `Remove ${name} from vars; it is declared as a required encrypted secret.`,
        configPath,
      })
      continue
    }
    if (!publicVarNames.has(name) && !/^(?:NUXT_)?PUBLIC_/i.test(name) && SECRET_NAME_RE.test(name)) {
      diagnostics.push({
        _tag: 'warning',
        code: 'plaintext-secret-var',
        message: `Move secret-looking variable ${name} to an encrypted Worker secret.`,
        configPath,
      })
    }
  }

  const consumers = config.queues?.consumers ?? []
  const deadLetterQueues = new Set(consumers.flatMap((consumer) => {
    return typeof consumer.dead_letter_queue === 'string' && consumer.dead_letter_queue.length > 0
      ? [consumer.dead_letter_queue]
      : []
  }))
  consumers.forEach((consumer, index) => {
    const retries = consumer.max_retries
    const retryDelay = consumer.retry_delay
    if (typeof retries === 'number' && (!Number.isSafeInteger(retries) || retries < 0 || retries > 100)) {
      diagnostics.push({
        _tag: 'error',
        code: 'queue-retries-out-of-range',
        message: 'Queue consumer max_retries must be an integer between 0 and 100.',
        configPath: `${prefix}queues.consumers.${index}.max_retries`,
      })
    }
    else if (typeof retries === 'number' && retries > 3) {
      diagnostics.push({
        _tag: 'warning',
        code: 'queue-retries-above-policy',
        message: `Queue consumer retries ${retries} times, above Cloudflare's default of 3. Verify the work is replay-safe.`,
        configPath: `${prefix}queues.consumers.${index}.max_retries`,
      })
    }
    const drainsDeadLetterQueue = typeof consumer.queue === 'string' && deadLetterQueues.has(consumer.queue)
    if (!drainsDeadLetterQueue
      && (typeof consumer.dead_letter_queue !== 'string' || consumer.dead_letter_queue.length === 0)) {
      diagnostics.push({
        _tag: 'warning',
        code: 'queue-dlq-missing',
        message: 'Configure a dead-letter queue or explicitly allow this warning for intentionally lossy work.',
        configPath: `${prefix}queues.consumers.${index}.dead_letter_queue`,
      })
    }
    if (typeof retryDelay === 'number' && (!Number.isSafeInteger(retryDelay) || retryDelay < 0 || retryDelay > 86_400)) {
      diagnostics.push({
        _tag: 'error',
        code: 'queue-retry-delay-out-of-range',
        message: 'Queue consumer retry_delay must be between 0 and 86400 seconds.',
        configPath: `${prefix}queues.consumers.${index}.retry_delay`,
      })
    }
  })
}

function diagnosePolicy(
  config: WranglerConfigInput,
  prefix: string,
  diagnostics: WranglerDiagnostic[],
  options: Required<Pick<WranglerDiagnosticOptions, 'compatibilityMaxAgeDays' | 'generated' | 'normalized' | 'now' | 'requireNodeCompat'>>,
  publicVarNames: ReadonlySet<string>,
): void {
  const compatibilityDate = config.compatibility_date

  if (compatibilityDate === undefined) {
    diagnostics.push({
      _tag: 'error',
      code: 'compatibility-date-missing',
      message: 'Set an explicit compatibility_date.',
      configPath: `${prefix}compatibility_date`,
    })
  }
  else {
    const parsed = parseDateOnly(compatibilityDate)
    if (!parsed) {
      diagnostics.push({
        _tag: 'error',
        code: 'compatibility-date-invalid',
        message: 'compatibility_date must be a real YYYY-MM-DD date.',
        configPath: `${prefix}compatibility_date`,
      })
    }
    else if ((options.now.getTime() - parsed.getTime()) / MILLISECONDS_PER_DAY > options.compatibilityMaxAgeDays) {
      diagnostics.push({
        _tag: 'warning',
        code: 'stale-compatibility-date',
        message: `compatibility_date is older than the ${options.compatibilityMaxAgeDays}-day project policy. Review compatibility flags before advancing it.`,
        configPath: `${prefix}compatibility_date`,
      })
    }
  }

  if (options.requireNodeCompat && !config.compatibility_flags?.includes('nodejs_compat')) {
    diagnostics.push({
      _tag: 'error',
      code: 'missing-nodejs-compat',
      message: 'Add nodejs_compat to compatibility_flags.',
      configPath: `${prefix}compatibility_flags`,
    })
  }
  if (options.requireNodeCompat
    && parsedCompatibilityDateBeforeV2(compatibilityDate)
    && config.compatibility_flags?.includes('nodejs_compat')
    && !config.compatibility_flags.includes('nodejs_compat_v2')
    && !config.compatibility_flags.includes('no_nodejs_compat_v2')) {
    diagnostics.push({
      _tag: 'error',
      code: 'nodejs-compat-version-implicit',
      message: 'Before 2024-09-23, choose nodejs_compat_v2 or no_nodejs_compat_v2 explicitly.',
      configPath: `${prefix}compatibility_flags`,
    })
  }
  if (config.observability?.enabled !== true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'observability-disabled',
      message: 'Enable Workers observability.',
      configPath: `${prefix}observability.enabled`,
    })
  }
  else {
    const samplingRates = [
      ['head_sampling_rate', config.observability.head_sampling_rate],
      ['logs.head_sampling_rate', config.observability.logs?.head_sampling_rate],
      ['traces.head_sampling_rate', config.observability.traces?.head_sampling_rate],
    ] as const
    for (const [path, rate] of samplingRates) {
      if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
        diagnostics.push({
          _tag: 'error',
          code: 'observability-sampling-out-of-range',
          message: 'Observability sampling rates must be finite numbers between 0 and 1.',
          configPath: `${prefix}observability.${path}`,
        })
      }
    }
    if (config.observability.traces?.enabled !== true) {
      diagnostics.push({
        _tag: 'warning',
        code: 'traces-disabled',
        message: 'Enable Workers traces with an explicit sampling rate.',
        configPath: `${prefix}observability.traces.enabled`,
      })
    }
    const logsEnabled = config.observability.logs?.enabled !== false
    const tracesEnabled = config.observability.traces?.enabled === true
    if ((logsEnabled && config.observability.logs?.head_sampling_rate === undefined)
      || (tracesEnabled && config.observability.traces?.head_sampling_rate === undefined)) {
      diagnostics.push({
        _tag: 'warning',
        code: 'observability-sampling-implicit',
        message: 'Set explicit log and trace sampling rates; enabled telemetry otherwise defaults to 100%.',
        configPath: `${prefix}observability`,
      })
    }
  }
  if (config.upload_source_maps !== true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'source-maps-disabled',
      message: 'Enable upload_source_maps when the Worker build emits source maps.',
      configPath: `${prefix}upload_source_maps`,
    })
  }
  if (!config.version_metadata?.binding) {
    diagnostics.push({
      _tag: 'warning',
      code: 'version-metadata-missing',
      message: 'Add a version_metadata binding for deployment correlation.',
      configPath: `${prefix}version_metadata`,
    })
  }
  if (config.keep_vars === true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'keep-vars-enabled',
      message: 'keep_vars allows dashboard-managed plaintext variables to drift from source control.',
      configPath: `${prefix}keep_vars`,
    })
  }
  if (config.cache === undefined) {
    diagnostics.push({
      _tag: 'warning',
      code: 'workers-cache-policy-implicit',
      message: 'Choose an explicit Workers Caching policy. Headerless 200 responses are cached for two hours when enabled.',
      configPath: `${prefix}cache`,
    })
  }
  else if (config.cache.enabled && config.cache.cross_version_cache === true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'workers-cache-cross-version-enabled',
      message: 'Cross-version caching can serve responses from superseded deployments until expiry or purge.',
      configPath: `${prefix}cache.cross_version_cache`,
    })
  }
  if (config.preview_urls === true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'preview-urls-public',
      message: 'Preview URLs are public unless protected by Access; their logs cannot be viewed through Workers Logs, tail, or Logpush.',
      configPath: `${prefix}preview_urls`,
    })
  }
  if (config.workers_dev === true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'workers-dev-enabled',
      message: 'The public workers.dev endpoint is enabled. Set workers_dev to false unless this is intentional.',
      configPath: `${prefix}workers_dev`,
    })
  }
  else if (config.workers_dev === undefined) {
    diagnostics.push({
      _tag: 'warning',
      code: 'workers-dev-implicit',
      message: 'Set workers_dev explicitly; current Wrangler behavior and published defaults differ when routes are present.',
      configPath: `${prefix}workers_dev`,
    })
  }

  diagnoseEnvironment(config, prefix, diagnostics, options.generated, options.normalized, publicVarNames)
}

function mergeObservability(
  inherited: WranglerObservabilityInput | undefined,
  environment: WranglerObservabilityInput | undefined,
): WranglerObservabilityInput | undefined {
  if (!inherited && !environment)
    return undefined
  return {
    ...inherited,
    ...environment,
    logs: inherited?.logs || environment?.logs
      ? { ...inherited?.logs, ...environment?.logs }
      : undefined,
    traces: inherited?.traces || environment?.traces
      ? { ...inherited?.traces, ...environment?.traces }
      : undefined,
  }
}

function resolveEnvironmentPolicy(
  root: WranglerConfigInput,
  environment: WranglerConfigInput,
): WranglerConfigInput {
  const exports = environment.exports ?? root.exports
  const migrations = environment.migrations ?? root.migrations
  return {
    ...environment,
    cache: environment.cache ?? root.cache,
    compatibility_date: environment.compatibility_date ?? root.compatibility_date,
    compatibility_flags: environment.compatibility_flags ?? root.compatibility_flags,
    ...(exports === undefined ? {} : { exports }),
    ...(migrations === undefined ? {} : { migrations }),
    observability: mergeObservability(root.observability, environment.observability),
    placement: environment.placement ?? root.placement,
    preview_urls: environment.preview_urls ?? root.preview_urls,
    upload_source_maps: environment.upload_source_maps ?? root.upload_source_maps,
    workers_dev: environment.workers_dev ?? root.workers_dev,
  }
}

export function diagnoseWranglerConfig(
  config: WranglerConfigInput,
  options: WranglerDiagnosticOptions = {},
): WranglerDiagnostic[] {
  const diagnostics: WranglerDiagnostic[] = []
  const diagnosticOptions = {
    compatibilityMaxAgeDays: options.compatibilityMaxAgeDays ?? 90,
    generated: options.generated ?? false,
    normalized: options.normalized ?? false,
    now: options.now ?? new Date(),
    requireNodeCompat: options.requireNodeCompat ?? true,
  }

  if (options.generated && Object.keys(config.env ?? {}).length > 0) {
    diagnostics.push({
      _tag: 'error',
      code: 'generated-config-has-env',
      message: 'Generated Wrangler config must target one flattened environment and contain no env block.',
      configPath: 'env',
    })
  }

  const publicVarNames = new Set(options.publicVarNames ?? [])
  diagnosePolicy(config, '', diagnostics, diagnosticOptions, publicVarNames)
  for (const [name, environment] of Object.entries(config.env ?? {})) {
    for (const category of WRANGLER_NON_INHERITED_BINDING_CATEGORIES) {
      const rootNames = collectCategoryBindingNames(config, category)
      const environmentNames = collectCategoryBindingNames(environment, category)
      const missingNames = [...rootNames].filter(binding => !environmentNames.has(binding))
      if (missingNames.length > 0) {
        diagnostics.push({
          _tag: 'warning',
          code: 'environment-binding-missing',
          message: `Named environments do not inherit ${category}. Add bindings for: ${missingNames.join(', ')}.`,
          configPath: `env.${name}.${category}`,
        })
      }
    }
    diagnosePolicy(
      resolveEnvironmentPolicy(config, environment),
      `env.${name}.`,
      diagnostics,
      diagnosticOptions,
      publicVarNames,
    )
  }

  return diagnostics
}

export function formatWranglerDiagnostics(diagnostics: readonly WranglerDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const location = [diagnostic.sourcePath, diagnostic.configPath].filter(Boolean).join(':')
      const severity = diagnostic._tag === 'error' ? 'ERROR' : diagnostic._tag === 'warning' ? 'WARN' : 'INFO'
      return `${severity} ${diagnostic.code}${location ? ` ${location}` : ''}: ${diagnostic.message}`
    })
    .join('\n')
}

export async function readWranglerJsonFile(path: string): Promise<WranglerJsonFileResult> {
  return readFile(path, 'utf8')
    .then((source): WranglerJsonFileResult => {
      const parsed = (() => {
        try {
          return { _tag: 'parsed' as const, value: JSON.parse(source) as unknown }
        }
        catch (error) {
          return { _tag: 'invalid' as const, reason: error instanceof Error ? error.message : String(error) }
        }
      })()
      if (parsed._tag === 'invalid')
        return { _tag: 'invalid', path, reason: parsed.reason }
      if (!isRecord(parsed.value))
        return { _tag: 'invalid', path, reason: 'top-level value must be an object' }
      return { _tag: 'loaded', path, config: parsed.value }
    })
    .catch((error: unknown): WranglerJsonFileResult => {
      if (isRecord(error) && error.code === 'ENOENT')
        return { _tag: 'missing', path }
      throw error
    })
}
