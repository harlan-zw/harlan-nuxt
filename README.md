# nuxt-cf-jobs

Typed Cloudflare Queue jobs for Nuxt.

`nuxt-cf-jobs` scans your Nuxt server job files, generates a typed registry, and gives you small runtime helpers for:

- building typed queue payloads
- sending jobs to Cloudflare Queue bindings
- consuming Cloudflare queue batches through Nitro hooks
- persisting durable jobs in D1
- testing queues without Cloudflare

## Install

```bash
pnpm add nuxt-cf-jobs
```

Add the module:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-cf-jobs'],
  cfJobs: {
    queues: {
      default: 'QUEUE_DEFAULT',
      analytics: {
        binding: 'QUEUE_ANALYTICS',
        queueName: 'analytics-production',
        jobType: 'analytics',
      },
    },
    jobsDir: 'server/jobs',
  },
})
```

`queues` maps your logical queue names to Cloudflare environment binding names. The string form uses the logical name as the Cloudflare queue name. The object form lets the Cloudflare queue name differ from the logical name.

## Define Jobs

Create default-exported jobs under `server/jobs`:

```ts
// server/jobs/sync/table.ts
import { defineJob } from '#cf-jobs/server'

export default defineJob({
  name: 'sync/table',
  queue: 'default',
  async handle(payload: {
    siteId: string
    userId: number
    table: string
    priority?: 'low' | 'normal'
  }, ctx) {
    ctx.log.info('syncing table', payload.table)
  },
})
```

Job names are derived from file paths for the generated registry, so this file is available as `sync/table`. Duplicate derived names fail during template generation.

The module ignores private/test files by default:

```ts
jobsIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts']
```

## Use The Typed Registry

The generated registry is available as `#cf-jobs/app` by default.

```ts
import type { JobName, JobPayload } from '#cf-jobs/app'
import {
  buildJobPayload,
  getJobDefinition,
  getQueue,

  prepareJob
} from '#cf-jobs/app'

const name: JobName = 'sync/table'

const payload = {
  siteId: 'site_1',
  userId: 123,
  table: 'pages',
  priority: 'low',
} satisfies JobPayload<'sync/table'>

const message = buildJobPayload(name, payload)
const definition = getJobDefinition(name)
```

Unknown job names and invalid payload shapes are rejected by TypeScript when the job payload type can be inferred from the job definition.

## Send Jobs

Use `getQueue(event, jobDefinition)` inside server routes, event handlers, Nitro plugins, or other server code where you have an `H3Event` or Cloudflare env-like source.

```ts
// server/api/sync.post.ts
import { getJobDefinition, getQueue } from '#cf-jobs/app'

export default defineEventHandler(async (event) => {
  const job = getJobDefinition('sync/table')
  if (!job)
    throw createError({ statusCode: 500, statusMessage: 'Job not registered' })

  const queue = getQueue(event, job)
  const queued = await queue.send({
    siteId: 'site_1',
    userId: 123,
    table: 'pages',
  })

  return { queued }
})
```

`queue.send()` returns `false` when the configured Cloudflare binding is unavailable. That lets development or unsupported runtimes fail explicitly without throwing.

In Nuxt dev, the module installs a dev-only Nitro plugin that creates in-memory queue bindings from your `cfJobs.queues` config and forwards messages to the `cloudflare:queue` hook.

## Consume Queue Batches

Register a queue consumer from a Nitro plugin:

```ts
// server/plugins/cf-jobs.ts
import { registerQueueConsumer } from '#cf-jobs/app'

export default defineNitroPlugin((nitroApp) => {
  registerQueueConsumer(nitroApp, {
    createContext({ env, job, message, control }) {
      return {
        env,
        db: null,
        log: console,
        jobId: job.id,
        batchId: job.batchId,
        attempt: message.attempts,
        async release(delaySeconds: number) {
          control.handled = true
          control.action = 'released'
          control.delaySeconds = delaySeconds
          message.retry({ delaySeconds })
        },
        async fail(error: string) {
          control.handled = true
          control.action = 'failed'
          control.error = error
          message.ack()
        },
      }
    },
  })
})
```

The generated `registerQueueConsumer()` wires the generated registry and `runtimeConfig.cfJobs.queues` for you. You provide only the application-specific context.

Useful options:

```ts
registerQueueConsumer(nitroApp, {
  createContext,
  getJobId: ({ payload }) => String(payload.jobId),
  getSiteId: payload => typeof payload.siteId === 'string' ? payload.siteId : null,
  getUserId: payload => typeof payload.userId === 'number' ? payload.userId : null,
  retryDelaySeconds: ({ error, job }) => 30,
  onInvalidPayload: input => console.warn(input.error),
  onDispatchError: input => console.error(input.error),
})
```

If you do not provide `getJobId`, the consumer uses `payload.jobId` when present, otherwise a stable serialized payload ID.

## Durable D1 Jobs

For jobs that should survive process restarts or queue delivery issues, persist a durable job record first, then enqueue a lightweight queue message.

```ts
import {
  createD1DurableJobRepository,
  createQueuePublisher,
  enqueueDurableJob,
} from 'nuxt-cf-jobs/server'
import { prepareJob } from '#cf-jobs/app'

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env as {
    DB: D1Database
    QUEUE_DEFAULT: Queue
  }

  const repository = createD1DurableJobRepository(env.DB)
  await repository.migrate()

  const publisher = createQueuePublisher(env, queue =>
    queue === 'default' ? 'QUEUE_DEFAULT' : undefined,)

  const record = await prepareJob({
    name: 'sync/table',
    payload: {
      siteId: 'site_1',
      userId: 123,
      table: 'pages',
    },
  })

  return await enqueueDurableJob(repository, publisher, record)
})
```

Consume durable queue messages with `runDurableJobMessage()` and the D1 repository:

```ts
import { createD1DurableJobRepository } from 'nuxt-cf-jobs/d1'
import { runDurableJobMessage } from 'nuxt-cf-jobs/durable'
import { jobRegistry } from '#cf-jobs/app'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch, env }) => {
    const repository = createD1DurableJobRepository(env.DB)

    for (const message of batch.messages) {
      await runDurableJobMessage({
        message,
        lifecycle: repository,
        registry: jobRegistry,
        toDispatchableJob: repository.toDispatchableJob,
        createJobContext({ job, storedJob, control }) {
          return {
            env,
            db: env.DB,
            log: console,
            jobId: job.id,
            batchId: job.batchId,
            attempt: job.attempts,
            async release(delaySeconds: number) {
              control.handled = true
              control.action = 'released'
              control.delaySeconds = delaySeconds
              await repository.releaseJob(storedJob, { delaySeconds })
              message.retry({ delaySeconds })
            },
            async fail(error: string) {
              control.handled = true
              control.action = 'failed'
              control.error = error
              await repository.failJob(storedJob, error)
            },
          }
        },
      })
    }
  })
})
```

`createD1DurableJobRepository()` exposes:

- `migrate()`
- `insertJob()`
- `claimJob()`
- `completeJob()`
- `failJob()`
- `releaseJob()`
- `findDispatchableJobs()`
- `findStaleReservedJobs()`
- `releaseStaleReservedJobs()`
- `toDispatchableJob()`

## Scheduled Tasks (cron)

Queue jobs handle per-request deferred work; **scheduled tasks** handle cron work. `defineScheduledTask` co-locates the cron schedule with its handler, and the module derives `nitro.tasks`, `nitro.scheduledTasks`, and the Cloudflare `triggers.crons` from it — so there is no central list to keep in sync (and no way for the three to silently drift apart).

```ts
// server/tasks/cleanup.ts
export default defineScheduledTask({
  name: 'db:cleanup', // nitro task name (also the runTask id)
  cron: '0 3 * * *', // or cron: ['0 3 * * *', '0 */6 * * *']
  description: 'Nightly cleanup',
  run() {
    // ...same shape as nitro defineTask's run
    return { result: 'ok' }
  },
})
```

Enable scanning via `cfJobs.tasksDir`:

```ts
export default defineNuxtConfig({
  cfJobs: {
    // `true` → auto-discover `server/tasks` in the app AND every extended layer
    // (nuxt.options._layers), so a new layer with cron work needs no host config.
    tasksDir: true,
    // …or be explicit: tasksDir: ['server/tasks', '../some-layer/server/tasks']
  },
})
```

Notes:

- `name` and `cron` must be **string literals** — the module reads them statically at build time (without executing the file, which typically imports a DB/server utils that won't load outside nitro). Computed values are skipped with a warning.
- Plain nitro `defineTask` files in the same dirs are still registered (so they're runnable via `runTask`), just not scheduled.
- `nitro.scheduledTasks` is populated only outside dev by default (so crons don't fire locally); override with `cfJobs.scheduledTasks: true | false`. The deploy-only `triggers.crons` is always written.
- Opt-in: nothing is scanned or registered unless `tasksDir` is set.

## CLI

The package ships a `cf-jobs` binary, an `artisan queue:*`-style tool for inspecting and managing the durable D1 job tables. It queries D1 through `wrangler d1 execute`, so it works against both the local miniflare database (default) and production (`--remote`), auto-detecting the D1 binding from your wrangler config.

```bash
# backpressure overview: per-queue ready/reserved/delayed, ready-lag, failures, stuck reservations
pnpm cf-jobs            # alias for `cf-jobs status`
pnpm cf-jobs status --remote

# inspect jobs
pnpm cf-jobs jobs --queue billing --state ready --limit 20
pnpm cf-jobs failed                       # artisan queue:failed
pnpm cf-jobs schedule                     # artisan schedule:list (cron + next run)
pnpm cf-jobs tasks                        # every discovered task

# manage (prompt for confirmation; pass --yes to skip, required when non-interactive)
pnpm cf-jobs retry <id>                   # artisan queue:retry — re-queue a failed job
pnpm cf-jobs retry --queue billing        # re-queue a whole queue's failures
pnpm cf-jobs forget <id>                  # artisan queue:forget
pnpm cf-jobs flush                        # artisan queue:flush — delete all failed jobs
pnpm cf-jobs clear --state reserved       # artisan queue:clear — drop active jobs (e.g. stuck reservations)
pnpm cf-jobs migrate                      # create the job tables/indexes in D1
```

Every command accepts `--config <wrangler path>`, `--db <binding>`, `--remote`, `--json`, and `--jobs-table` / `--failed-table` overrides. `status` flags queues whose oldest ready job is lagging and reservations stuck for more than five minutes (a crashed or timed-out consumer). Run `cf-jobs <command> --help` for the full argument list.

`cf-jobs` shells out to `wrangler`; it resolves the binary from `node_modules/.bin`, falling back to `wrangler` on `PATH` (override with `CF_JOBS_WRANGLER_BIN`).

## Runtime Validation

The generated registry validates jobs at startup. It fails loudly for:

- invalid job definitions
- duplicate job names
- missing or invalid queue names

Queue binding checks are available from `#cf-jobs/app`:

```ts
import { assertQueueBindings, validateQueueBindings } from '#cf-jobs/app'

const issues = validateQueueBindings()
assertQueueBindings()
```

## Public Imports

Use the narrow subpaths when you can:

```ts
import { createD1DurableJobRepository } from 'nuxt-cf-jobs/d1'
import { runDurableJobMessage } from 'nuxt-cf-jobs/durable'
import { defineJob } from 'nuxt-cf-jobs/server'
import { createFakeQueue } from 'nuxt-cf-jobs/testing'
```

Available package subpaths:

- `nuxt-cf-jobs` - Nuxt module
- `nuxt-cf-jobs/server` - full server runtime barrel
- `nuxt-cf-jobs/d1` - D1 durable repository adapter
- `nuxt-cf-jobs/durable` - durable outbox helpers
- `nuxt-cf-jobs/queue` - queue binding and consumer helpers
- `nuxt-cf-jobs/schema` - Drizzle schema
- `nuxt-cf-jobs/testing` - fake queue helpers

Inside a Nuxt app, prefer the generated aliases:

- `#cf-jobs/server` for server runtime helpers
- `#cf-jobs/app` for your generated typed job registry

## Tests

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

`pnpm test:e2e` starts Wrangler fixtures and requires the local Cloudflare/Wrangler toolchain to be available.
