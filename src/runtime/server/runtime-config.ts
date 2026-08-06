import type { useRuntimeConfig } from 'nitropack/runtime'
import { resolveNitroTaskEnv, runtimeConfigSource } from './runtime-env'

type UseRuntimeConfig = typeof useRuntimeConfig

/**
 * Nitro's `useRuntimeConfig`, injected at startup by the `provide-runtime-config`
 * server plugin (which IS bundled by nitro, so it can reach the runtime safely).
 *
 * Why injection rather than a module-top `import { useRuntimeConfig } from
 * 'nitropack/runtime'`: this file is re-exported by the `nuxt-cf-jobs/server`
 * barrel, which the generated `#cf-jobs/app` registry imports — and nitro dev
 * loads that registry as a raw external `file://` module. A module-top import of
 * `nitropack/runtime` there eagerly pulls nitro's `internal/storage.mjs`, whose
 * `#nitro-internal-virtual/storage` specifier only resolves inside the nitro
 * rollup build, so it throws `ERR_PACKAGE_IMPORT_NOT_DEFINED` and crashes the
 * dev server at boot (cached, so every request 500s). Keeping the reference
 * injected keeps the generated registry framework-independent.
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
 * (`resolveNitroTaskEnv`) and wraps it as the event-shaped source
 * `useRuntimeConfig` applies env overrides from.
 *
 * On the request path keep calling `useRuntimeConfig(event)` directly — the
 * event already binds the vars.
 */
export function useJobRuntimeConfig(event?: unknown): ReturnType<typeof useRuntimeConfig> {
  if (!injectedUseRuntimeConfig) {
    throw new Error(
      '[nuxt-cf-jobs] useJobRuntimeConfig() was read before nitro\'s `useRuntimeConfig` was injected. The `provide-runtime-config` server plugin injects it at startup — ensure the nuxt-cf-jobs module is installed and its server plugins are registered, and that no job is dispatched before nitro boots.',
    )
  }
  if (event)
    return injectedUseRuntimeConfig(event as never)
  const env = resolveNitroTaskEnv()
  return injectedUseRuntimeConfig(env ? runtimeConfigSource(env) as never : undefined)
}
