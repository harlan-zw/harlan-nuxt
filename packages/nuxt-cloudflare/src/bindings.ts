type BindingName<Environment extends object> = Extract<keyof Environment, string>

type CloudflareEntryHost = typeof globalThis & { __env__?: unknown }

export interface CloudflareBindingSource {
  cloudflare?: unknown
  context?: unknown
}

export interface CloudflareBindings<Environment extends object> {
  resolve: (source?: CloudflareBindingSource) => Environment | undefined
  get: <Name extends BindingName<Environment>>(
    name: Name,
    source?: CloudflareBindingSource,
  ) => Environment[Name] | undefined
  require: <Name extends BindingName<Environment>>(
    name: Name,
    source?: CloudflareBindingSource,
  ) => Exclude<Environment[Name], undefined>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

function envFromContext(value: unknown): Record<string, unknown> | undefined {
  const cloudflare = asRecord(value)?.cloudflare
  return asRecord(asRecord(cloudflare)?.env)
}

function resolveEnvironment<Environment extends object>(source?: CloudflareBindingSource): Environment | undefined {
  const sourceRecord = asRecord(source)
  const sourceEnv = envFromContext(sourceRecord?.context) ?? envFromContext(sourceRecord)
  const globalEnv = asRecord((globalThis as CloudflareEntryHost).__env__)
  return (sourceEnv ?? globalEnv) as Environment | undefined
}

/**
 * Creates typed binding access for Wrangler's generated `Env` or `CloudflareEnv`.
 *
 * The source may be an H3 event, a Nitro task run input, or a Nitro task context.
 * If the source has no environment, Nitro's Cloudflare entry shim is used.
 */
export function createCloudflareBindings<Environment extends object>(): CloudflareBindings<Environment> {
  function get<Name extends BindingName<Environment>>(
    name: Name,
    source?: CloudflareBindingSource,
  ): Environment[Name] | undefined {
    const env = resolveEnvironment<Environment>(source)
    return env && Object.hasOwn(env, name) ? env[name] : undefined
  }

  function requireBinding<Name extends BindingName<Environment>>(
    name: Name,
    source?: CloudflareBindingSource,
  ): Exclude<Environment[Name], undefined> {
    const binding = get(name, source)
    if (binding === undefined)
      throw new Error(`Cloudflare binding "${name}" is unavailable`)
    return binding as Exclude<Environment[Name], undefined>
  }

  return {
    resolve: resolveEnvironment,
    get,
    require: requireBinding,
  }
}
