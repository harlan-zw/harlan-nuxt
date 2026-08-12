import type { useRuntimeConfig } from 'nitropack/runtime'
import { resolveCloudflareBindings, runtimeConfigSource } from './runtime-env'

type UseRuntimeConfig = typeof useRuntimeConfig

/**
 * A runtime config reader explicitly provided by a host or test.
 *
 * Why injection rather than a module-top `import { useRuntimeConfig } from
 * 'nitropack/runtime'`: this file is re-exported by the `nuxt-cf-jobs/server`
 * barrel, which applications can import outside a Nitro bundle. Nitro dev can
 * load that registry as a raw external `file://` module. A module-top import of
 * `nitropack/runtime` there eagerly pulls nitro's `internal/storage.mjs`, whose
 * `#nitro-internal-virtual/storage` specifier only resolves inside the nitro
 * rollup build, so it throws `ERR_PACKAGE_IMPORT_NOT_DEFINED` and crashes the
 * dev server at boot (cached, so every request 500s). Explicit injection keeps
 * this package module framework-independent.
 */
let injectedUseRuntimeConfig: UseRuntimeConfig | undefined

export function provideJobRuntimeConfig(fn: UseRuntimeConfig): void {
  injectedUseRuntimeConfig = fn
}

/**
 * `useRuntimeConfig` for eventless cf-jobs contexts — queue-job handlers,
 * scheduled tasks, and plugin hooks fired off the request path.
 *
 * A bare `useRuntimeConfig()` there misses the deployment's `NUXT_*` worker
 * vars/secrets: on Cloudflare they only bind onto `runtimeConfig.*` through an
 * `H3Event`'s `cloudflare.env`, so an eventless read returns the empty
 * build-time defaults (this is the footgun that left queue jobs without their
 * creds). The Cloudflare worker entry assigns the live env to
 * `globalThis.__env__` at *every* handler (`queue`, `scheduled`, `email`,
 * `tail`, and the durable-object `fetch`), so this reads that shim
 * (`resolveCloudflareBindings`) and wraps it as the event-shaped source
 * `useRuntimeConfig` applies env overrides from.
 *
 * On the request path keep calling `useRuntimeConfig(event)` directly — the
 * event already binds the vars.
 */
export function useJobRuntimeConfig(event?: unknown): ReturnType<typeof useRuntimeConfig> {
  if (!injectedUseRuntimeConfig) {
    throw new Error(
      '[nuxt-cf-jobs] useJobRuntimeConfig() was read before a runtime config reader was provided. Pass `useRuntimeConfig` to createCfJobsApp() or call provideJobRuntimeConfig() at the host boundary.',
    )
  }
  if (event)
    return injectedUseRuntimeConfig(event as never)
  const env = resolveCloudflareBindings()
  return injectedUseRuntimeConfig(env ? runtimeConfigSource(env) as never : undefined)
}
