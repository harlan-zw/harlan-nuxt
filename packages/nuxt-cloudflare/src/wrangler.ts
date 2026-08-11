import { readFile } from 'node:fs/promises'

export interface WranglerAssetsInput {
  directory?: string
  binding?: string
  run_worker_first?: boolean | string[]
}

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
  assets?: WranglerAssetsInput
  compatibility_date?: string
  compatibility_flags?: string[]
  env?: Record<string, WranglerConfigInput>
  observability?: WranglerObservabilityInput
  queues?: {
    consumers?: Array<Record<string, unknown>>
  }
  secrets?: {
    required?: string[]
  }
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
}

export interface WranglerDiagnostic {
  _tag: 'error' | 'warning'
  code:
    | 'assets-worker-first'
    | 'compatibility-date-missing'
    | 'compatibility-date-invalid'
    | 'missing-nodejs-compat'
    | 'observability-disabled'
    | 'plaintext-secret-var'
    | 'queue-retries-excessive'
    | 'secret-declared-as-var'
    | 'source-maps-disabled'
    | 'stale-compatibility-date'
    | 'version-metadata-missing'
    | 'workers-dev-enabled'
  message: string
  path: string
}

export interface WranglerDiagnosticOptions {
  compatibilityMaxAgeDays?: number
  now?: Date
  publicVarNames?: readonly string[]
}

export type WranglerJsonFileResult
  = | { _tag: 'loaded', config: WranglerConfigInput, path: string }
    | { _tag: 'missing', path: string }
    | { _tag: 'invalid', path: string, reason: string }

const SECRET_NAME_RE = /(?:^|_)(?:API_?KEY|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

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

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key)
}

export function applyCloudflareDefaults(
  config: WranglerConfigInput,
  options: CloudflareDefaultOptions = {},
): WranglerConfigInput {
  const compatibilityFlags = unique([...(config.compatibility_flags ?? []), 'nodejs_compat'])
  const requiredSecrets = unique([...(config.secrets?.required ?? []), ...(options.requiredSecrets ?? [])])
  const logs = config.observability?.logs
  const traces = config.observability?.traces
  const uploadSourceMaps = config.upload_source_maps ?? options.uploadSourceMaps ?? true
  const environments = config.env && Object.fromEntries(
    Object.entries(config.env).map(([name, environment]) => [name, {
      ...environment,
      ...(requiredSecrets.length > 0
        ? { secrets: { ...environment.secrets, required: unique([...(environment.secrets?.required ?? []), ...requiredSecrets]) } }
        : {}),
    }]),
  )

  return {
    ...config,
    ...(config.compatibility_date === undefined && options.compatibilityDate
      ? { compatibility_date: options.compatibilityDate }
      : {}),
    compatibility_flags: compatibilityFlags,
    observability: {
      ...config.observability,
      enabled: config.observability?.enabled ?? true,
      logs: {
        ...logs,
        enabled: logs?.enabled ?? true,
        head_sampling_rate: logs?.head_sampling_rate ?? options.logsSampleRate ?? 0.1,
        invocation_logs: logs?.invocation_logs ?? true,
      },
      traces: {
        ...traces,
        enabled: traces?.enabled ?? true,
        head_sampling_rate: traces?.head_sampling_rate ?? options.tracesSampleRate ?? 0.01,
      },
    },
    ...(requiredSecrets.length > 0 ? { secrets: { ...config.secrets, required: requiredSecrets } } : {}),
    ...(environments ? { env: environments } : {}),
    upload_source_maps: uploadSourceMaps,
    version_metadata: config.version_metadata ?? {
      binding: options.versionMetadataBinding ?? 'CF_VERSION_METADATA',
    },
  }
}

function diagnoseEnvironment(
  config: WranglerConfigInput,
  prefix: string,
  diagnostics: WranglerDiagnostic[],
  publicVarNames: ReadonlySet<string>,
): void {
  if (config.assets && hasOwn(config.assets, 'run_worker_first')) {
    diagnostics.push({
      _tag: 'error',
      code: 'assets-worker-first',
      message: 'Remove assets.run_worker_first. Static assets must bypass the Worker.',
      path: `${prefix}assets.run_worker_first`,
    })
  }

  const requiredSecrets = new Set(config.secrets?.required ?? [])
  for (const name of Object.keys(config.vars ?? {})) {
    const path = `${prefix}vars.${name}`
    if (requiredSecrets.has(name)) {
      diagnostics.push({
        _tag: 'error',
        code: 'secret-declared-as-var',
        message: `Remove ${name} from vars; it is declared as a required encrypted secret.`,
        path,
      })
      continue
    }
    if (!publicVarNames.has(name) && !/^(?:NUXT_)?PUBLIC_/i.test(name) && SECRET_NAME_RE.test(name)) {
      diagnostics.push({
        _tag: 'error',
        code: 'plaintext-secret-var',
        message: `Move secret-looking variable ${name} to an encrypted Worker secret.`,
        path,
      })
    }
  }

  const consumers = config.queues?.consumers ?? []
  consumers.forEach((consumer, index) => {
    const retries = consumer.max_retries
    if (typeof retries === 'number' && retries > 10) {
      diagnostics.push({
        _tag: 'warning',
        code: 'queue-retries-excessive',
        message: `Queue consumer retries ${retries} times; verify this is intentional and backed by a DLQ.`,
        path: `${prefix}queues.consumers.${index}.max_retries`,
      })
    }
  })
}

export function diagnoseWranglerConfig(
  config: WranglerConfigInput,
  options: WranglerDiagnosticOptions = {},
): WranglerDiagnostic[] {
  const diagnostics: WranglerDiagnostic[] = []
  const now = options.now ?? new Date()
  const maxAgeDays = options.compatibilityMaxAgeDays ?? 90
  const compatibilityDate = config.compatibility_date

  if (compatibilityDate === undefined) {
    diagnostics.push({
      _tag: 'error',
      code: 'compatibility-date-missing',
      message: 'Set an explicit compatibility_date.',
      path: 'compatibility_date',
    })
  }
  else {
    const parsed = parseDateOnly(compatibilityDate)
    if (!parsed) {
      diagnostics.push({
        _tag: 'error',
        code: 'compatibility-date-invalid',
        message: 'compatibility_date must be a real YYYY-MM-DD date.',
        path: 'compatibility_date',
      })
    }
    else if ((now.getTime() - parsed.getTime()) / MILLISECONDS_PER_DAY > maxAgeDays) {
      diagnostics.push({
        _tag: 'warning',
        code: 'stale-compatibility-date',
        message: `compatibility_date is older than the ${maxAgeDays}-day project policy. Review compatibility flags before advancing it.`,
        path: 'compatibility_date',
      })
    }
  }

  if (!config.compatibility_flags?.includes('nodejs_compat')) {
    diagnostics.push({
      _tag: 'error',
      code: 'missing-nodejs-compat',
      message: 'Add nodejs_compat to compatibility_flags.',
      path: 'compatibility_flags',
    })
  }
  if (config.observability?.enabled !== true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'observability-disabled',
      message: 'Enable Workers observability.',
      path: 'observability.enabled',
    })
  }
  if (config.upload_source_maps !== true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'source-maps-disabled',
      message: 'Enable upload_source_maps when the Worker build emits source maps.',
      path: 'upload_source_maps',
    })
  }
  if (!config.version_metadata?.binding) {
    diagnostics.push({
      _tag: 'warning',
      code: 'version-metadata-missing',
      message: 'Add a version_metadata binding for deployment correlation.',
      path: 'version_metadata',
    })
  }
  if (config.workers_dev === true) {
    diagnostics.push({
      _tag: 'warning',
      code: 'workers-dev-enabled',
      message: 'Production workers.dev exposure is enabled; verify this is intentional.',
      path: 'workers_dev',
    })
  }

  const publicVarNames = new Set(options.publicVarNames ?? [])
  diagnoseEnvironment(config, '', diagnostics, publicVarNames)
  for (const [name, environment] of Object.entries(config.env ?? {}))
    diagnoseEnvironment(environment, `env.${name}.`, diagnostics, publicVarNames)

  return diagnostics
}

export function formatWranglerDiagnostics(diagnostics: readonly WranglerDiagnostic[]): string {
  return diagnostics
    .map(diagnostic => `${diagnostic._tag === 'error' ? 'ERROR' : 'WARN'} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
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
