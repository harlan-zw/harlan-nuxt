import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The plugin imports `defineNitroPlugin` + `useRuntimeConfig` from
// `nitropack/runtime`, which isn't resolvable outside a built nitro app. Mock
// it so `defineNitroPlugin` returns the setup fn (we invoke it directly) and
// `useRuntimeConfig` returns a controllable config carrying `cfJobs.queues`.
const runtimeConfig: { cfJobs?: { queues?: Record<string, string | { binding: string }> } } = {}
vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: <T>(setup: T): T => setup,
  useRuntimeConfig: () => runtimeConfig,
}))

type Handler = (...args: any[]) => any

// Minimal hookable-like stand-in for the NitroApp the plugin receives. It
// records hook registrations and lets the test fire `request`/`cloudflare:queue`.
function createNitroAppStub() {
  const handlers = new Map<string, Handler[]>()
  return {
    handlers,
    hooks: {
      hook(name: string, handler: Handler) {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
      },
      async callHook(name: string, payload: unknown) {
        for (const handler of handlers.get(name) ?? [])
          await handler(payload)
      },
    },
  }
}

const taskEnvHost = globalThis as { __env__?: Record<string, unknown> }
let savedTaskEnv: Record<string, unknown> | undefined

beforeEach(() => {
  savedTaskEnv = taskEnvHost.__env__
  delete taskEnvHost.__env__
  runtimeConfig.cfJobs = undefined
})

afterEach(() => {
  if (savedTaskEnv === undefined)
    delete taskEnvHost.__env__
  else
    taskEnvHost.__env__ = savedTaskEnv
  vi.resetModules()
})

async function loadPlugin() {
  const mod = await import('../src/runtime/server/plugins/dev-queues')
  return mod.default as (nitroApp: ReturnType<typeof createNitroAppStub>) => void
}

describe('dev-queues nitro plugin', () => {
  it('mirrors the queue runtime onto globalThis.__env__ so getQueue(job) resolves in task/cron contexts', async () => {
    // (a) The task-env shim must carry the in-process queue bindings after the
    // plugin runs — `resolveNitroTaskEnv()` reads `globalThis.__env__`, so
    // without this task/cron/listener-triggered jobs enqueue to nothing.
    runtimeConfig.cfJobs = { queues: { default: 'JOBS', billing: { binding: 'BILLING_QUEUE' } } }
    const nitroApp = createNitroAppStub()

    const plugin = await loadPlugin()
    plugin(nitroApp)

    expect(taskEnvHost.__env__).toBeDefined()
    // Both queue bindings present on the shim, and they are usable queue objects.
    expect(taskEnvHost.__env__!.JOBS).toBeDefined()
    expect(taskEnvHost.__env__!.BILLING_QUEUE).toBeDefined()
    expect(typeof (taskEnvHost.__env__!.JOBS as { send: unknown }).send).toBe('function')
  })

  it('preserves pre-existing real bindings on the shim (real binding wins over queue stub)', async () => {
    // The merge order is `{ ...runtime.env, ...existing }` — any real binding
    // already on the shim must survive (matches the request-precedence rule).
    const realDb = { __real: 'NUXT_SEO_PRO_DB' }
    taskEnvHost.__env__ = { NUXT_SEO_PRO_DB: realDb }
    runtimeConfig.cfJobs = { queues: { default: 'JOBS' } }
    const nitroApp = createNitroAppStub()

    const plugin = await loadPlugin()
    plugin(nitroApp)

    expect(taskEnvHost.__env__!.JOBS).toBeDefined()
    expect(taskEnvHost.__env__!.NUXT_SEO_PRO_DB).toBe(realDb)
  })

  it('merges base globalThis.__env__ bindings into the onBatch consumer env so the consumer sees D1/KV', async () => {
    // (b) When a job actually runs, the consumer needs the base Cloudflare
    // bindings (D1/KV/…). The plugin wires its in-process runtime's `onBatch`
    // to call the `cloudflare:queue` hook with `{ ...baseEnv, ...payload.env }`
    // where baseEnv = globalThis.__env__. Observe the env the consumer receives.
    const realDb = { __real: 'NUXT_SEO_PRO_DB' }
    const realKv = { __real: 'KV' }
    taskEnvHost.__env__ = { NUXT_SEO_PRO_DB: realDb, KV: realKv }
    runtimeConfig.cfJobs = { queues: { default: 'JOBS' } }
    const nitroApp = createNitroAppStub()

    const plugin = await loadPlugin()
    plugin(nitroApp)

    // Capture what the `cloudflare:queue` consumer hook receives.
    const consumerEnvs: Array<Record<string, unknown>> = []
    nitroApp.hooks.hook('cloudflare:queue', (payload: { env: Record<string, unknown> }) => {
      consumerEnvs.push(payload.env)
    })

    // Drive a real enqueue through the in-process queue so the plugin's own
    // `onBatch` fires the hook — exercises the merge for real, not a stub call.
    const queue = taskEnvHost.__env__!.JOBS as { send: (m: unknown) => Promise<void> }
    await queue.send({ _task: 'noop' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(consumerEnvs).toHaveLength(1)
    const consumerEnv = consumerEnvs[0]!
    // Base D1/KV bindings flowed through to the consumer.
    expect(consumerEnv.NUXT_SEO_PRO_DB).toBe(realDb)
    expect(consumerEnv.KV).toBe(realKv)
    // Queue binding is still present too (it's part of payload.env).
    expect(consumerEnv.JOBS).toBeDefined()
  })

  it('no-ops when no queues are configured (never touches the shim)', async () => {
    runtimeConfig.cfJobs = { queues: {} }
    const nitroApp = createNitroAppStub()

    const plugin = await loadPlugin()
    plugin(nitroApp)

    expect(taskEnvHost.__env__).toBeUndefined()
    expect(nitroApp.handlers.has('request')).toBe(false)
  })
})
