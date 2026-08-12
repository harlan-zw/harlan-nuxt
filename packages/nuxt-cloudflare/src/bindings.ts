type BindingName<Environment extends object> = Extract<keyof Environment, string>

type CloudflareEntryHost = typeof globalThis & { __env__?: unknown }

declare global {
  interface CloudflareBindings {}
}

export interface CloudflareRuntimeConfigSource<Environment extends object> {
  context: {
    nitro: Record<string, never>
    cloudflare: {
      env: Environment
    }
  }
}

export interface CloudflareBindingAccessor<Environment extends object> {
  resolve: (source?: unknown) => Environment | undefined
  get: <Name extends BindingName<Environment>>(
    name: Name,
    source?: unknown,
  ) => Environment[Name] | undefined
  require: <Name extends BindingName<Environment>>(
    name: Name,
    source?: unknown,
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

export function resolveCloudflareBindings<Environment extends object = CloudflareBindings>(source?: unknown): Environment | undefined {
  const sourceRecord = asRecord(source)
  const sourceEnv = envFromContext(sourceRecord?.context) ?? envFromContext(sourceRecord)
  const globalEnv = asRecord((globalThis as CloudflareEntryHost).__env__)
  return (sourceEnv ?? globalEnv) as Environment | undefined
}

/** Creates the event-shaped source required by Nitro runtime config resolution. */
export function runtimeConfigSource<Environment extends object>(env: Environment): CloudflareRuntimeConfigSource<Environment> {
  return {
    context: {
      nitro: {},
      cloudflare: { env },
    },
  }
}

/**
 * Creates typed binding access for the generated `CloudflareBindings` environment.
 *
 * The source may be an H3 event, a Nitro task run input, or a Nitro task context.
 * If the source has no environment, Nitro's Cloudflare entry shim is used.
 */
export function createCloudflareBindings<Environment extends object = CloudflareBindings>(): CloudflareBindingAccessor<Environment> {
  function get<Name extends BindingName<Environment>>(
    name: Name,
    source?: unknown,
  ): Environment[Name] | undefined {
    const env = resolveCloudflareBindings<Environment>(source)
    return env && Object.hasOwn(env, name) ? env[name] : undefined
  }

  function requireBinding<Name extends BindingName<Environment>>(
    name: Name,
    source?: unknown,
  ): Exclude<Environment[Name], undefined> {
    const binding = get(name, source)
    if (binding === undefined)
      throw new Error(`Cloudflare binding "${name}" is unavailable`)
    return binding as Exclude<Environment[Name], undefined>
  }

  return {
    resolve: resolveCloudflareBindings,
    get,
    require: requireBinding,
  }
}
