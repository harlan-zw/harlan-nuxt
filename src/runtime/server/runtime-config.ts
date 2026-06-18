// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { useRuntimeConfig } from 'nitropack/runtime'
import { resolveNitroTaskEnv, runtimeConfigSource } from './queue'

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
export function useJobRuntimeConfig(): ReturnType<typeof useRuntimeConfig> {
  const env = resolveNitroTaskEnv()
  return useRuntimeConfig(env ? runtimeConfigSource(env) : undefined)
}
