import type { H3Event } from 'h3'
import type { NitroRuntimeConfig } from 'nitropack/types'

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

/** Sets the environment used by eventless Cloudflare binding resolution. */
export function setCloudflareBindings<Environment extends object>(env: Environment | undefined): void {
  const host = globalThis as CloudflareEntryHost
  if (env === undefined)
    delete host.__env__
  else
    host.__env__ = env
}

/** Merges binding sources into the eventless environment. Later sources win. */
export function mergeCloudflareBindings<Environment extends object = CloudflareBindings>(
  ...sources: Array<Partial<Environment> | undefined>
): Environment {
  const merged = Object.assign({}, ...sources.filter(source => source !== undefined)) as Environment
  setCloudflareBindings(merged)
  return merged
}

/**
 * Creates the event-shaped source Nitro runtime config resolution requires.
 *
 * `useRuntimeConfig` writes the resolved config onto `context.nitro`, so a
 * source without that object throws for every read that reaches it. Two
 * production incidents came from a source that omitted it.
 *
 * The return type includes `H3Event` because that is the parameter
 * `useRuntimeConfig` declares, and this value carries every field it reads.
 * It is a config source, never a request: no other H3 helper may receive it.
 */
export function runtimeConfigSource<Environment extends object>(
  env: Environment,
): CloudflareRuntimeConfigSource<Environment> & H3Event {
  const source: CloudflareRuntimeConfigSource<Environment> = {
    context: {
      nitro: {},
      cloudflare: { env },
    },
  }
  return source as CloudflareRuntimeConfigSource<Environment> & H3Event
}

/** Reads Nitro runtime config for one event, or the shared config without one. */
export type NitroRuntimeConfigReader = (event?: H3Event) => NitroRuntimeConfig

let nitroRuntimeConfigReader: NitroRuntimeConfigReader | undefined

/**
 * Provides Nitro's `useRuntimeConfig` to `useCloudflareRuntimeConfig`.
 *
 * The module's own Nitro plugin calls this. The reader is injected rather than
 * imported because this file is also loaded outside a Nitro bundle, where a
 * module-top `nitropack/runtime` import resolves virtual specifiers that only
 * exist inside the Nitro build and crashes the development server at boot.
 */
export function provideCloudflareRuntimeConfig(read: NitroRuntimeConfigReader | undefined): void {
  nitroRuntimeConfigReader = read
}

/**
 * Reads Nitro runtime config from Cloudflare request and eventless contexts.
 *
 * Pass the request event on the request path. Off it, in queue consumers,
 * scheduled handlers, email handlers, and Nitro tasks, there is no event and a
 * bare `useRuntimeConfig()` returns build-time defaults: the deployment's
 * `NUXT_*` Worker vars and secrets bind onto runtime config only through an
 * event. The Cloudflare entry assigns the live environment to
 * `globalThis.__env__` in every handler, so the eventless path reads that and
 * wraps it as a runtime config source.
 */
export function useCloudflareRuntimeConfig(event?: H3Event): NitroRuntimeConfig {
  if (!nitroRuntimeConfigReader) {
    throw new Error(
      '[nuxt-cloudflare] No Nitro runtime config reader is available. Keep the module enabled, or call provideCloudflareRuntimeConfig() at the host boundary.',
    )
  }
  if (event)
    return nitroRuntimeConfigReader(event)
  const env = resolveCloudflareBindings<Record<string, unknown>>()
  return nitroRuntimeConfigReader(env ? runtimeConfigSource(env) : undefined)
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
