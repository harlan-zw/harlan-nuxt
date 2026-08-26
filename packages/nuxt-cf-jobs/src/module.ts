import type { Nuxt } from '@nuxt/schema'
import type { RegistrySourcesContext } from './build/registry'
import type { DiscoveredTask } from './tasks'
import type { BroadcastOptions, ModuleOptions, ReconcileOptions } from './types'
import { relative, resolve } from 'node:path'
import { findProjectWranglerConfig } from '@harlan-zw/nuxt-cloudflare/wrangler'
import { addImportsDir, addServerHandler, addServerImports, addServerPlugin, addTemplate, createResolver, defineNuxtModule, useLogger } from '@nuxt/kit'
import { resolveLayeredDirs } from './build/layers'
import { inlineTemplateInNitroDev } from './build/nitro-dev'
import { installRegistryTemplates } from './build/registry'
import { CF_JOBS_BROADCAST_DEFAULT_ROUTE } from './runtime/shared/broadcast-constants'
import { buildCronUnion, buildScheduledTasks, collectTasks, findDuplicateTaskNames } from './tasks'
import {
  crossCheckCrons,
  enrichQueuesWithConsumerConfig,
  parseWranglerConfig,
  reconcileQueues,
  renderSuggestedCronsToml,
} from './wrangler'

export { generateRegistryTemplate, generateRegistryTypesTemplate } from './build/registry'
export type { RegistrySource, RegistrySourcesContext } from './build/registry'
export type { BroadcastOptions, ModuleOptions, ReconcileOptions } from './types'

declare module '@nuxt/schema' {
  interface NuxtHooks {
    'cf-jobs:registry:sources': (context: RegistrySourcesContext) => void | Promise<void>
  }
  interface RuntimeConfig {
    cfJobs: {
      queues: ModuleOptions['queues']
      defaultQueue?: string
      broadcast?: ResolvedBroadcastOptions
      reconcile?: ResolvedReconcileOptions
    }
  }
  interface PublicRuntimeConfig {
    cfJobs?: {
      broadcast?: { route: string }
    }
  }
}

interface ResolvedBroadcastOptions extends Required<Pick<BroadcastOptions, 'route' | 'durableObjectBinding' | 'durableObjectName'>> {}
interface ResolvedReconcileOptions extends Required<Pick<ReconcileOptions, 'staleSeconds' | 'orphanedSeconds' | 'redispatchGraceSeconds' | 'redeliveryGraceSeconds' | 'orphanedBatchSeconds' | 'limit'>> {
  d1Binding?: string
}

/**
 * Ownership window for a reserved row, in seconds.
 *
 * One value drives two knobs that MUST agree: `reconcile.staleSeconds` (when the
 * reaper treats a reservation as abandoned) and the consumer's
 * `reclaimAfterSeconds` (when a redelivery may take the row from its holder).
 * When they drift, reconcile releases and re-dispatches a job the consumer is
 * still running, so the losing copy is terminalized without settling its batch.
 *
 * 900s exceeds any realistic handler runtime, so only a dead reservation
 * (isolate recycle, Worker limit) is reclaimed.
 */
export const CF_JOBS_DEFAULT_RESERVATION_SECONDS = 900

/**
 * How long a due, unreserved row must sit before the sweep calls it orphaned.
 *
 * This is a producer rate control, not only a recovery knob. The orphan test
 * cannot tell "the dispatch was lost" from "dispatched fine, still queued", so a
 * window shorter than the worst queue wait makes the backstop re-dispatch work
 * that was never lost, which deepens the queue, which makes the next rows wait
 * longer. On a `max_concurrency: 1` consumer that wait is hours. The old 600s
 * default made the backstop the largest producer on a production account
 * (8,987 writes/hr against 95 reads/hr, and a 122k backlog rebuilt in 23h).
 */
export const CF_JOBS_DEFAULT_ORPHANED_SECONDS = 6 * 60 * 60

export default defineNuxtModule<ModuleOptions>().with({
  meta: {
    name: '@harlan-zw/nuxt-cf-jobs',
    configKey: 'cfJobs',
    compatibility: { nuxt: '>=4.5.0 <6.0.0' },
  },
  defaults: {
    queues: {},
    jobsDir: 'server/jobs',
    jobsPattern: '**/*.ts',
    jobsIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    // tasksDir is opt-in: scanning + registering tasks mutates nitro.tasks /
    // scheduledTasks / triggers.crons, so it only runs when explicitly set.
    tasksPattern: '**/*.ts',
    tasksIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    registryAlias: '#cf-jobs/app',
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const queues = options.queues as ModuleOptions['queues']
    const hasQueues = Object.keys(queues).length > 0
    const broadcast = resolveBroadcastOptions(options.broadcast)
    const reconcile = resolveReconcileOptions(options.reconcile)

    nuxt.options.alias['#cf-jobs/server'] = resolver.resolve('./runtime/server')
    // Cloudflare Analytics Engine sink lives on its own subpath so its
    // Workers-specific `writeDataPoint` shape never loads with the core barrel.
    nuxt.options.alias['#cf-jobs/cloudflare'] = resolver.resolve('./runtime/server/cloudflare')
    const nitro = ((nuxt.options as { nitro?: { alias?: Record<string, string> } }).nitro ??= {})
    nitro.alias ??= {}
    nitro.alias['@harlan-zw/nuxt-cf-jobs/runtime-config'] = resolver.resolve('./runtime/server/nitro-runtime-config')
    addImportsDir(resolver.resolve('./runtime/app/composables'))
    addServerImports([
      { name: 'defineJob', from: resolver.resolve('./runtime/server/registry') },
      { name: 'defineScheduledTask', from: resolver.resolve('./runtime/server/scheduled') },
    ])
    installRegistryTemplates(options, nuxt, resolve(nuxt.options.buildDir, 'cf-jobs'))
    if (reconcile)
      installReconcileContextTemplate(options.reconcile, nuxt)

    if (options.defaultQueue && !queues[options.defaultQueue])
      useLogger('nuxt-cf-jobs').warn(`cfJobs.defaultQueue="${options.defaultQueue}" is not a key of cfJobs.queues`)

    // In dev, fill each queue's lane budget (max_concurrency / max_batch_size) from
    // the wrangler consumer config so `cf-jobs work` fans out at the real per-queue
    // concurrency without the app duplicating it into `cfJobs.queues`. Prod is
    // unaffected (the real consumer reads wrangler directly).
    let runtimeQueues = queues
    if (nuxt.options.dev && hasQueues) {
      const wranglerPath = options.wranglerPath
        ? resolve(nuxt.options.rootDir, options.wranglerPath)
        : findProjectWranglerConfig(nuxt.options.rootDir)
      const { expectations, merged } = reconcileQueues({
        queues,
        fileWrangler: wranglerPath ? parseWranglerConfig(wranglerPath) : undefined,
        nitroOptions: (nuxt.options as { nitro?: unknown }).nitro,
        fallbackPath: wranglerPath ?? nuxt.options.rootDir,
      })
      runtimeQueues = enrichQueuesWithConsumerConfig(queues, expectations, merged?.consumers ?? [])
    }

    nuxt.options.runtimeConfig.cfJobs = {
      ...(nuxt.options.runtimeConfig.cfJobs ?? {}),
      queues: nuxt.options.runtimeConfig.cfJobs?.queues ?? runtimeQueues,
      defaultQueue: nuxt.options.runtimeConfig.cfJobs?.defaultQueue ?? options.defaultQueue,
      broadcast: nuxt.options.runtimeConfig.cfJobs?.broadcast ?? broadcast ?? undefined,
      reconcile: nuxt.options.runtimeConfig.cfJobs?.reconcile ?? reconcile ?? undefined,
    }

    if (broadcast) {
      enableNitroWebSocket(nuxt)
      setPublicBroadcastConfig(nuxt, broadcast)
      addServerHandler({
        route: broadcast.route,
        lazy: true,
        handler: resolver.resolve('./runtime/server/handlers/broadcast-ws'),
      })
    }

    if (nuxt.options.dev && hasQueues) {
      addServerPlugin(resolver.resolve('./runtime/server/plugins/dev-queues'))
      // Dev-only worker endpoint driven by `cf-jobs work`: drains durable jobs
      // out-of-band through the app's consumer so WebSockets see live progress.
      // Never registered outside dev — it's an unauthenticated job executor.
      addServerHandler({
        route: '/__cf-jobs/work',
        method: 'post',
        lazy: true,
        handler: resolver.resolve('./runtime/server/handlers/dev-work'),
      })
    }

    if (options.validateWrangler !== false && hasQueues)
      runWranglerCrossCheck(options, nuxt.options.rootDir, resolve(nuxt.options.buildDir, 'cf-jobs'), (nuxt.options as { nitro?: unknown }).nitro)

    if (options.tasksDir || reconcile) {
      nuxt.hook('modules:done', () =>
        wireScheduledTasks(options, nuxt, resolve(nuxt.options.buildDir, 'cf-jobs')))
    }
  },
})

function resolveBroadcastOptions(input: ModuleOptions['broadcast']): ResolvedBroadcastOptions | null {
  if (!input)
    return null
  if (input !== true && input.enabled === false)
    return null
  const opts = input === true ? {} : input
  return {
    route: normalizeRoute(opts.route ?? CF_JOBS_BROADCAST_DEFAULT_ROUTE),
    durableObjectBinding: opts.durableObjectBinding ?? '$DurableObject',
    durableObjectName: opts.durableObjectName ?? 'server',
  }
}

export function resolveReconcileOptions(input: ModuleOptions['reconcile']): ResolvedReconcileOptions | null {
  if (!isReconcileEnabled(input))
    return null
  const opts: ReconcileOptions = typeof input === 'object' ? input : {}
  const orphanedSeconds = opts.orphanedSeconds ?? CF_JOBS_DEFAULT_ORPHANED_SECONDS
  return {
    staleSeconds: opts.staleSeconds ?? CF_JOBS_DEFAULT_RESERVATION_SECONDS,
    orphanedSeconds,
    // One re-send per orphan window per row. The two controls multiply: the
    // window bounds how many rows qualify, this bounds how often each one is
    // re-sent. Neither alone bounds the sweep's write rate.
    redispatchGraceSeconds: opts.redispatchGraceSeconds ?? orphanedSeconds,
    redeliveryGraceSeconds: opts.redeliveryGraceSeconds ?? 120,
    orphanedBatchSeconds: opts.orphanedBatchSeconds ?? 7 * 86400,
    limit: opts.limit ?? 100,
    ...(opts.d1Binding ? { d1Binding: opts.d1Binding } : {}),
  }
}

function isReconcileEnabled(input: ModuleOptions['reconcile']): boolean {
  return input !== false && (input === true || input === undefined || input.enabled !== false)
}

export function installReconcileContextTemplate(input: ModuleOptions['reconcile'], nuxt: Nuxt): void {
  const contextModule = typeof input === 'object' ? input.terminalFailureContext : undefined
  const template = addTemplate({
    filename: 'cf-jobs/reconcile-context.mjs',
    write: true,
    getContents: () => renderReconcileContextProxy(nuxt.options.rootDir, contextModule),
  })
  nuxt.options.alias['#cf-jobs/reconcile-context'] = template.dst
  // The template re-exports application source by absolute path. Nitro leaves
  // buildDir modules outside its dev bundle, so without this Node's own ESM
  // loader reads that source and fails on its TypeScript syntax and path
  // aliases, which errors every route. Inlining hands the file to Rollup.
  inlineTemplateInNitroDev(nuxt, template.dst)
}

export function renderReconcileContextProxy(rootDir: string, contextModule?: string): string {
  if (!contextModule)
    return 'export const createReconcileJobContext = undefined\n'
  const resolved = resolve(rootDir, contextModule).replace(/\\/g, '/')
  return `export { createReconcileJobContext } from ${JSON.stringify(resolved)}\n`
}

function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : `/${route}`
}

function enableNitroWebSocket(nuxt: Nuxt): void {
  const nitro = ((nuxt.options as { nitro?: Record<string, any> }).nitro ??= {})
  nitro.experimental ??= {}
  nitro.experimental.websocket = true
}

function setPublicBroadcastConfig(nuxt: Nuxt, broadcast: ResolvedBroadcastOptions): void {
  const runtimeConfig = nuxt.options.runtimeConfig as {
    public?: {
      cfJobs?: {
        broadcast?: { route: string }
      }
    }
  }
  runtimeConfig.public ??= {}
  runtimeConfig.public.cfJobs = {
    ...(runtimeConfig.public.cfJobs ?? {}),
    broadcast: { route: broadcast.route },
  }
}

/**
 * Discover `defineScheduledTask` / `defineTask` files under `tasksDir`, register
 * their handlers in `nitro.tasks`, derive `nitro.scheduledTasks` + the wrangler
 * `triggers.crons` union from co-located crons, and cross-check an external
 * wrangler file. Replaces hand-maintaining all three lists in `nuxt.config`.
 */
async function wireScheduledTasks(options: ModuleOptions, nuxt: Nuxt, templateDir: string): Promise<void> {
  const logger = useLogger('nuxt-cf-jobs')
  const rootDir = nuxt.options.rootDir
  // Always scan the module's OWN runtime tasks dir so the recovery backstop
  // (`cf-jobs:reconcile`) registers in every consuming app, even one that didn't
  // configure `tasksDir`. App task dirs are layered on top when configured.
  const moduleTasksDir = createResolver(import.meta.url).resolve('./runtime/server/tasks')
  // App task dirs honour the user's `tasksPattern` (default `**/*.ts` — apps ship
  // source). The module's OWN dir ships COMPILED `.js` in consumers (and `.ts` in
  // this repo's playground), so scan it with an extension-agnostic pattern of its
  // own — reusing the user's `**/*.ts` here silently dropped `reconcile.js`, so
  // the recovery cron never registered in any built app.
  const userTasksDir = options.tasksDir ? resolveTaskDirs(options.tasksDir, nuxt) : []
  const { tasks: userTasks, unnamed } = userTasksDir.length
    ? await collectTasks({ ...options, tasksDir: userTasksDir }, rootDir)
    : { tasks: [], unnamed: [] as string[] }
  const { tasks: moduleTasks } = isReconcileEnabled(options.reconcile)
    ? await collectTasks(
        { ...options, tasksDir: [moduleTasksDir], tasksPattern: '**/*.{ts,mts,cts,js,mjs,cjs}', tasksIgnore: ['**/*.d.ts', '**/*.d.mts'] },
        rootDir,
      )
    : { tasks: [] as DiscoveredTask[] }
  const tasks = [...userTasks, ...moduleTasks]

  for (const file of unnamed)
    logger.warn(`nuxt-cf-jobs: task at ${relative(rootDir, file)} declares a cron but no statically-readable string-literal \`name\` — skipped.`)

  if (tasks.length === 0)
    return

  const dupes = findDuplicateTaskNames(tasks)
  if (dupes.length > 0)
    throw new Error(`Duplicate nuxt-cf-jobs task names: ${dupes.join(', ')}`)

  // `nitro.cloudflare.*` and `nitro.tasks` aren't on the public Nuxt nitro type
  // surface here; the module already casts nitro options elsewhere.
  const nitro = ((nuxt.options as { nitro?: Record<string, any> }).nitro ??= {})

  // 1. Register every discovered task handler — replaces the hand-maintained
  //    `nitro.tasks` map. Name comes from the file's declared `name`.
  nitro.tasks ??= {}
  for (const t of tasks) {
    const existing = nitro.tasks[t.name] as { handler?: string } | undefined
    if (existing && existing.handler && existing.handler !== t.handler)
      logger.warn(`nuxt-cf-jobs: task "${t.name}" already registered (${existing.handler}) — overriding with ${relative(rootDir, t.file)}.`)
    nitro.tasks[t.name] = { ...existing, handler: t.handler }
  }

  // 2. Cron schedule. Gated off in dev by default so crons don't fire locally
  //    (mirrors the common `NODE_ENV === 'production' ? {...} : {}` pattern).
  const scheduled = tasks.filter(t => t.crons.length > 0)
  const cronUnion = buildCronUnion(tasks)
  const enableSchedule = options.scheduledTasks ?? !nuxt.options.dev
  if (enableSchedule && scheduled.length > 0)
    nitro.scheduledTasks = buildScheduledTasks(tasks, (nitro.scheduledTasks ?? {}) as Record<string, string[]>)

  // 3. Cloudflare cron triggers — always written (deploy-only metadata). This is
  //    the list that silently drifts from scheduledTasks when hand-maintained.
  if (cronUnion.length > 0) {
    nitro.cloudflare ??= {}
    nitro.cloudflare.wrangler ??= {}
    nitro.cloudflare.wrangler.triggers ??= {}
    nitro.cloudflare.wrangler.triggers.crons = buildCronUnion(tasks, nitro.cloudflare.wrangler.triggers.crons ?? [])
  }

  // 4. Validate-and-suggest against an external wrangler file that manages crons
  //    directly (mirrors the queue cross-check). Files with no `[triggers]`
  //    block are left alone — nitro generates that section from the config above.
  if (options.validateWrangler !== false && cronUnion.length > 0) {
    addTemplate({
      filename: 'cf-jobs/crons.suggested.toml',
      write: true,
      getContents: () => renderSuggestedCronsToml(cronUnion),
    })
    const wranglerPath = options.wranglerPath ? resolve(rootDir, options.wranglerPath) : findProjectWranglerConfig(rootDir)
    if (wranglerPath) {
      const { crons } = parseWranglerConfig(wranglerPath)
      if (crons !== undefined) {
        const { missing, extra } = crossCheckCrons(crons, cronUnion)
        if (missing.length > 0)
          logger.warn(`nuxt-cf-jobs / cron drift in ${wranglerPath}: missing trigger(s) ${missing.join(', ')} — those scheduled tasks won't fire on deploy. See ${resolve(templateDir, 'crons.suggested.toml')}.`)
        if (extra.length > 0)
          logger.info(`nuxt-cf-jobs: ${wranglerPath} declares cron trigger(s) no task uses: ${extra.join(', ')}.`)
      }
    }
  }

  logger.info(`nuxt-cf-jobs: registered ${tasks.length} task(s); ${scheduled.length} scheduled across ${cronUnion.length} cron(s)${enableSchedule ? '' : ' (schedule disabled in dev)'}.`)
}

/**
 * Resolve `cfJobs.tasksDir` into a concrete dir list. `true` auto-discovers
 * `server/tasks` across the app + every extended layer (`nuxt.options._layers`);
 * a string/array is passed through (collectTasks resolves them from rootDir).
 */
function resolveTaskDirs(tasksDir: NonNullable<ModuleOptions['tasksDir']>, nuxt: Nuxt): string[] {
  return resolveLayeredDirs(tasksDir, nuxt, 'server/tasks')
}

function runWranglerCrossCheck(options: ModuleOptions, rootDir: string, templateDir: string, nitroOptions: unknown): void {
  const logger = useLogger('nuxt-cf-jobs')
  const wranglerPath = options.wranglerPath
    ? resolve(rootDir, options.wranglerPath)
    : findProjectWranglerConfig(rootDir)

  const { expectations, suggestedToml, merged, issues } = reconcileQueues({
    queues: options.queues,
    fileWrangler: wranglerPath ? parseWranglerConfig(wranglerPath) : undefined,
    nitroOptions,
    fallbackPath: wranglerPath ?? rootDir,
  })

  if (expectations.length === 0)
    return

  // Always emit the suggested wrangler snippet so users can diff it.
  addTemplate({
    filename: 'cf-jobs/wrangler.suggested.toml',
    write: true,
    getContents: () => suggestedToml,
  })

  if (!merged) {
    logger.warn(`No wrangler.{toml,jsonc,json} found in ${rootDir} and no queues declared via nitro.cloudflare.wrangler. See ${resolve(templateDir, 'wrangler.suggested.toml')} for the expected [[queues.producers]] / [[queues.consumers]] blocks.`)
    return
  }

  if (issues.length === 0)
    return

  const lines = issues.map(i => `  - [${i.logical}] ${i.reason}: ${i.detail}`)
  logger.warn(`nuxt-cf-jobs / wrangler config drift in ${merged.path}:\n${lines.join('\n')}\nSee ${resolve(templateDir, 'wrangler.suggested.toml')} for the expected blocks.`)
}
