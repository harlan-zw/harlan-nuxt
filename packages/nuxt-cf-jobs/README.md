# Nuxt CF Jobs

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

> Typed Cloudflare Queue jobs for Nuxt, with a Laravel-style API.

## Why Nuxt CF Jobs?

Cloudflare Queues give you a producer binding and a consumer hook. You write everything between them yourself:

- 🧾 **Untyped payloads**: Each dispatch site retypes the payload, so a renamed field breaks in the consumer at runtime.
- 🔀 **Routing glue**: You map each job to its producer binding by hand, and your Wrangler config drifts from that map.
- 💥 **Lost jobs**: A failed send or a crashed run drops the job and its failure history.
- ⏰ **Duplicated cron**: Each schedule lives twice, once in Nitro config and once in Wrangler config.

Nuxt CF Jobs generates a typed job registry from `server/jobs` and routes each job to its queue binding. D1 durability, cron, and realtime progress are opt-in.

## Features

- 📁 **File-based typed jobs**: You never hand-write a job registry or retype a payload at each dispatch site.
- ☁️ **Cloudflare Queues**: Each job reaches the right producer binding without routing glue code per queue.
- 🗄️ **Optional D1 durability**: A lost send or a crashed run no longer loses the job or its failure history.
- ⏰ **Scheduled tasks**: You write each cron once, beside its task, instead of copying it into Nitro and Wrangler config.
- 📡 **Realtime progress**: Your UI shows live job and batch progress without a polling endpoint you build yourself.

## Installation

```bash
npx nuxi@latest module add @harlan-zw/nuxt-cf-jobs
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-cf-jobs
> ```

## Quick start

The basic path sends a typed message straight to Cloudflare Queues. D1 is optional; see [Durable jobs](#durable-jobs).

### 1. Map your queues

Map each logical queue name to the binding exposed by Cloudflare:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-cf-jobs'],
  cfJobs: {
    queues: {
      default: 'QUEUE_DEFAULT',
      analytics: {
        binding: 'QUEUE_ANALYTICS',
        queueName: 'analytics-production',
      },
    },
    defaultQueue: 'default',
  },
})
```

`default` and `analytics` are logical names used by your jobs. `QUEUE_DEFAULT` and `QUEUE_ANALYTICS` are Worker binding names. The object form lets the Cloudflare queue name differ from the logical name.

By default, the module scans `server/jobs` for jobs. It skips private, declaration, test, and spec files.

### 2. Configure Cloudflare

Merge matching producers, consumers, and observability settings into the `wrangler.jsonc` used by your Nuxt deployment. See Cloudflare's [Queues configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/) and [Workers observability](https://developers.cloudflare.com/workers/observability/) docs for all options.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "compatibility_date": "YYYY-MM-DD",
  "compatibility_flags": ["nodejs_compat"],
  "queues": {
    "producers": [
      { "binding": "QUEUE_DEFAULT", "queue": "default" },
      { "binding": "QUEUE_ANALYTICS", "queue": "analytics-production" }
    ],
    "consumers": [
      { "queue": "default" },
      { "queue": "analytics-production" }
    ]
  },
  "observability": {
    "enabled": true,
    "logs": { "enabled": true, "head_sampling_rate": 1 },
    "traces": { "enabled": true, "head_sampling_rate": 0.01 }
  }
}
```

Before you deploy, pick a real `compatibility_date` and test it. If you change bindings, regenerate Worker types:

```bash
pnpm exec wrangler types
```

The module reads JSONC, JSON, and TOML. At build time it compares the root queue config with `cfJobs.queues`, warns about drift, and writes a reference snippet to `.nuxt/cf-jobs/wrangler.suggested.toml`.

[Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/) do not inherit bindings or variables. Repeat them inside every named environment you deploy. Put local secrets in an ignored `.dev.vars` file and set deployed secrets with `pnpm exec wrangler secret put NAME`.

### 3. Define a job

```ts
// server/jobs/sync/table.ts
import { defineJob } from '#cf-jobs/server'

export default defineJob({
  name: 'sync/table',
  queue: 'default',
  tries: 3,
  backoff: [10, 60, 300],
  async handle(payload: {
    siteId: string
    table: string
    priority?: 'low' | 'normal'
  }) {
    console.info(`Syncing ${payload.table} for ${payload.siteId}`)
  },
})
```

Use string literals for `name` and `queue`. The module reads routing metadata without running the job file. If you omit `name`, the module uses the path relative to `jobsDir`. Duplicate names stop the build.

Common job options:

| Option | Purpose |
| --- | --- |
| `input` | Validate payloads with a `safeParse()` compatible schema. |
| `tries` | Set the total attempt limit. |
| `backoff` | Set a retry delay, a delay sequence, or a function of the attempt number. |
| `middleware` | Wrap the handler with shared job middleware. |
| `failed` | Run job-specific failure handling. |
| `unique` / `uniqueId` | Deduplicate active durable jobs by payload or a custom key. |
| `broadcast` | Replace the default lifecycle channels with an app-specific event. |

### 4. Register the consumer

Create one Nitro plugin for lightweight queue messages:

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
        },
        async fail(error: string) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }
    },
    onInvalidPayload: input => console.warn(input.error),
    onDispatchError: input => console.error(input.error),
  })
})
```

The consumer calls `ack()` and `retry()`. Your `ctx.release()` and `ctx.fail()` only record the requested action on `control`.

By default, the consumer uses `payload.jobId` as the runtime job ID. If `payload.jobId` is absent, the consumer derives a stable ID from the payload. If your payload uses another identifier, pass `getJobId`.

### 5. Dispatch a job

The generated `#cf-jobs/app` registry types the payload from the job name:

```ts
// server/api/sync.post.ts
import { getJobDefinition, getQueue } from '#cf-jobs/app'

export default defineEventHandler(async (event) => {
  const job = getJobDefinition('sync/table')
  if (!job)
    throw createError({ statusCode: 500, statusMessage: 'Job not registered' })

  const queued = await getQueue(event, job).send({
    siteId: 'site_1',
    table: 'pages',
    priority: 'normal',
  })

  return { queued }
})
```

`send()` returns `false` when the binding is missing and logs one warning for that job and binding. Cloudflare send errors still reject.

During `nuxt dev`, the module creates in-memory queue bindings from `cfJobs.queues` and forwards messages to the same `cloudflare:queue` hook.

## Typed registry

`#cf-jobs/app` is generated from your job files:

```ts
import type { JobName, JobPayload } from '#cf-jobs/app'
import { buildJobPayload, getJobDefinition, loadJobDefinition } from '#cf-jobs/app'

const name: JobName = 'sync/table'

const payload = {
  siteId: 'site_1',
  table: 'pages',
  priority: 'low',
} satisfies JobPayload<'sync/table'>

const message = buildJobPayload(name, payload)
const route = getJobDefinition(name)
const fullDefinition = await loadJobDefinition(name)
```

`getJobDefinition()` returns static routing and literal policy metadata without loading the job module. It leaves out executable fields such as `handle`, `input`, and `uniqueId`. If you need the full definition, use `loadJobDefinition()`. The durable `prepareJob()` helper calls it for you. For each job with `broadcast`, the registry also generates `JobBroadcastMessage<Name>` and `JobBroadcastEnvelope<Name>` types.

To fail a custom startup check on bad queue bindings, use the runtime validators:

```ts
import { assertQueueBindings, validateQueueBindings } from '#cf-jobs/app'

const issues = validateQueueBindings()
assertQueueBindings()
```

## Choose a delivery mode

| | Lightweight | Durable |
| --- | --- | --- |
| Dispatch | `getQueue(...).send(payload)` | `prepareJob()` then `runtime.enqueue(record)` |
| Storage | Cloudflare Queue only | D1 row plus Cloudflare Queue message |
| Consumer | `registerQueueConsumer()` | `runtime.consumeBatch()` |
| Best for | Short, idempotent work | Work that needs recovery, history, batches, or live progress |
| CLI state | No | Yes |

Both modes use the same `defineJob` files and generated types. Cloudflare Queues deliver at least once, so make each handler safe to run twice. The durable path claims the D1 row before each run, and the CLI can show every step of the lifecycle.

## Durable jobs

### Add D1

Add a D1 binding next to the queues in your Wrangler config:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-jobs",
      "database_id": "<database-id>"
    }
  ]
}
```

Create the local tables. When you are ready, apply the same migration remotely:

```bash
pnpm cf-jobs migrate
pnpm cf-jobs migrate --remote
```

### Create the runtime

Build the runtime in one server utility. Then the queue consumer and the producers share bindings and context:

```ts
// server/utils/cf-jobs-runtime.ts
import { createDurableRuntime } from '#cf-jobs/app'

export interface JobsEnv extends Record<string, unknown> {
  DB: D1Database
  QUEUE_DEFAULT: Queue
  QUEUE_ANALYTICS: Queue
}

export function createJobsRuntime(env: JobsEnv) {
  return createDurableRuntime({
    db: env.DB,
    env,
    createJobContext({ job, control }) {
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
        },
        async fail(error: string) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }
    },
  })
}
```

Consume both durable `{ jobId }` messages and lightweight `{ _task }` messages through that runtime:

```ts
// server/plugins/cf-jobs-durable.ts
import type { JobsEnv } from '~/server/utils/cf-jobs-runtime'
import { createJobsRuntime } from '~/server/utils/cf-jobs-runtime'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch, env }) => {
    await createJobsRuntime(env as JobsEnv).consumeBatch(batch)
  })
})
```

Use this plugin instead of the lightweight `registerQueueConsumer()` plugin from the quick start. If you register both, two consumers handle every batch.

### Enqueue a durable job

```ts
// server/api/sync-durable.post.ts
import type { JobsEnv } from '~/server/utils/cf-jobs-runtime'
import { prepareJob } from '#cf-jobs/app'
import { createJobsRuntime } from '~/server/utils/cf-jobs-runtime'

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env as JobsEnv
  const runtime = createJobsRuntime(env)
  const record = await prepareJob({
    name: 'sync/table',
    payload: {
      siteId: 'site_1',
      table: 'pages',
    },
  })

  return await runtime.enqueue(record)
})
```

`runtime.enqueue()` returns one of four explicit states:

- `enqueued`: the D1 row was inserted and the queue accepted the message.
- `duplicate`: a matching active unique job already exists.
- `not-dispatched`: the row is safe in D1, but the queue binding was unavailable.
- `dispatch-failed`: the row is safe in D1, and `cause` contains the send error.

The generated `prepareJob()` loads the full job definition and validates the payload. It also resolves the queue, applies attempts and uniqueness, and checks the serialized payload against the D1 storage limit. All of this happens before any row is written.

### Recovery

The module registers the `cf-jobs:reconcile` task by default. It runs every two minutes. It reclaims stale reservations and re-dispatches older due rows that have no queue message. It also closes orphaned batches when it has enough terminal evidence.

A queue message can reach its DLQ while a run still holds the row. If durable attempts remain, the row becomes unpublished, and the sweep sends a replacement once it releases the stale reservation. If no durable attempts remain, the row becomes a terminal failure.

```ts
export default defineNuxtConfig({
  cfJobs: {
    reconcile: {
      d1Binding: 'DB',
      terminalFailureContext: './server/cf-jobs-reconcile-context.ts',
      staleSeconds: 900,
      orphanedSeconds: 6 * 60 * 60,
      redispatchGraceSeconds: 6 * 60 * 60,
      redeliveryGraceSeconds: 120,
      orphanedBatchSeconds: 7 * 86400,
      limit: 100,
    },
    // Set false only when the app owns durable recovery.
    // reconcile: false,
  },
})
```

If the Worker exposes more than one D1-like binding, set `d1Binding`.

The sweep is a producer, so two windows bound its write rate.

- `orphanedSeconds` decides which rows qualify. The orphan test cannot tell a
  lost dispatch from a row that is still queued. Keep it above the worst queue
  wait. On a `max_concurrency: 1` consumer, that wait is hours.
- `redispatchGraceSeconds` decides how often the sweep may re-send one row. It
  counts from the row's last successful dispatch (`last_dispatched_at`), which
  the producer stamps. A row that waits its turn is never re-sent inside the
  window.

`staleSeconds` is the row's ownership window. The durable consumer's
`reclaimAfterSeconds` defaults to the same value, so the reaper and a redelivery
agree on when a reservation is abandoned. Set `staleSeconds` above your longest
handler runtime. If it is shorter, the reaper releases and re-dispatches a job
that is still running. The losing copy then becomes terminal without settling
its batch. Pass `reclaimAfterSeconds` to `createDurableRuntime()` only when you
want a different value on purpose.

### Held rows

A redelivery cannot claim a row that another run holds. The consumer retries
that message with backoff: 60s on the first delivery, doubled on each later one,
clamped to Cloudflare's 43200s ceiling. After two retries, the consumer acks
the message.

Cloudflare counts deliveries, not elapsed time. A message that keeps retrying
spends the queue's `max_retries` and dead-letters with `attempts = 0`. The
handler never runs. The ack prevents this. The row keeps its reservation, so
the reconcile sweep still owns it: the sweep releases the reservation after
`staleSeconds`, then re-dispatches the row.

```ts
createDurableRuntime({
  // A number, or a function of `{ jobId, deliveries }`.
  // Pass 60 to restore the old flat delay.
  inFlightRetryDelaySeconds: 60,
  // Raise this only when the app runs no recovery sweep.
  maxInFlightRetries: 2,
})
```

To ack the first time a row is held, set `maxInFlightRetries: 0`. This spends
no extra delivery, so a held row never reaches the dead-letter queue.

If you set `reconcile: false`, no sweep runs. In that case, raise
`maxInFlightRetries` or run recovery from the app.

`terminalFailureContext` points to an app module that exports
`createReconcileJobContext`. If your jobs have `failed` callbacks, set it. An
isolate can die during its final claim. The stale reaper then commits the
`failed_jobs` row and must rebuild your app services to run `failed`. Without
this module, the reaper keeps the `failed_jobs` row and logs an error, but it
skips `failed`. The package cannot build your database and logger context for
you.

## Broadcasting

Broadcasting uses named channels. Built-in lifecycle channels are `job:<id>`, `batch:<id>`, and `queue:<name>`. App channels can use `cfJobsChannel('site', siteId)` or any valid `scope:id` string.

Enable the WebSocket route and use Nitro's Cloudflare Durable preset:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  cfJobs: {
    broadcast: true, // /__cf-jobs/ws
  },
  nitro: {
    preset: 'cloudflare-durable',
    cloudflare: {
      wrangler: {
        durable_objects: {
          bindings: [{ name: '$DurableObject', class_name: '$DurableObject' }],
        },
        migrations: [{ tag: 'v1', new_classes: ['$DurableObject'] }],
      },
    },
  },
})
```

Add `broadcast: true` to the durable runtime from the previous section:

```ts
return createDurableRuntime({
  // Keep the existing db, env, and createJobContext options.
  broadcast: true,
  completeResult: ({ job }) => ({ jobId: job.id }),
})
```

Watch jobs and batches from Vue code:

```vue
<script setup lang="ts">
const jobId = ref<string | null>(null)
const { state, result, error } = useCfJob(jobId)

const { progress, finished } = useCfJobBatch('batch_123')

useCfJobsChannel(cfJobsChannel('site', 'site_1'), (event) => {
  if (event.event === 'sync.table.updated')
    console.log(event.data)
})
</script>
```

To send an app event instead of the default lifecycle events, add `broadcast` to the job:

```ts
// server/jobs/sync/table.ts
import { cfJobsChannel, defineJob } from '#cf-jobs/server'

export default defineJob({
  name: 'sync/table',
  queue: 'default',
  async handle(payload: { siteId: string, table: string }) {
    // ...
  },
  broadcast({ payload, status }) {
    return {
      channel: cfJobsChannel('site', payload.siteId),
      event: 'sync.table.updated',
      data: { table: payload.table, status },
    } as const
  },
})
```

To publish from any server code, call `publishCfJobsBroadcast()`. To protect private channels, use the authorization hook:

```ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cf-jobs:broadcast:authorize', async (ctx) => {
    if (ctx.channel.startsWith('site:') && !await userCanAccessSite(ctx.peer.request, ctx.channel))
      ctx.authorized = false
  })
})
```

## Scheduled tasks

`defineScheduledTask` keeps the task name, cron, and handler together. The module derives `nitro.tasks`, `nitro.scheduledTasks`, and Cloudflare `triggers.crons` from the files it finds.

```ts
// server/tasks/cleanup.ts
export default defineScheduledTask({
  name: 'db:cleanup',
  cron: '0 3 * * *',
  description: 'Delete expired records',
  run() {
    return { result: 'ok' }
  },
})
```

Enable app task discovery:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  cfJobs: {
    tasksDir: true,
  },
})
```

`tasksDir: true` scans `server/tasks` in the app and every extended Nuxt layer. To set the directories yourself, pass a path or an array of paths.

- `name` and `cron` must be string literals because they are read at build time.
- `cron` accepts one expression or an array. Cloudflare Cron Triggers run in UTC.
- The module registers plain Nitro `defineTask` files in the same directories for manual runs.
- App task discovery is opt-in. The built-in recovery task is separate. It stays on unless you set `reconcile: false`.
- Scheduled runs are off in development by default. To run crons locally, set `scheduledTasks: true`.

If your Wrangler file already contains `triggers.crons`, the module checks it for drift and writes `.nuxt/cf-jobs/crons.suggested.toml`.

## CLI

The `cf-jobs` binary reads the durable D1 tables through Wrangler. It uses local D1 by default. For the deployed database, add `--remote`.

| Command | Use |
| --- | --- |
| `cf-jobs status` | Show ready, reserved, delayed, failed, and lagging jobs by queue. |
| `cf-jobs jobs` | List active jobs with queue, type, state, and limit filters. |
| `cf-jobs failed` | List failed jobs and their exceptions. |
| `cf-jobs retry` | Requeue a failed job, a queue's failures, or all failures. |
| `cf-jobs forget` / `flush` | Delete one failed job or a group of failures. |
| `cf-jobs clear` | Delete active jobs, optionally filtered by queue or state. |
| `cf-jobs prune` | Remove terminal rows past the requested retention windows. |
| `cf-jobs migrate` | Create the job and batch tables and indexes. |
| `cf-jobs schedule` / `tasks` | Inspect scheduled or discovered Nitro tasks. |
| `cf-jobs work` | Drain durable jobs through a running `nuxt dev` server. |
| `cf-jobs watch` | Stream completed and failed dev jobs as NDJSON. |

Examples:

```bash
pnpm cf-jobs status --remote
pnpm cf-jobs jobs --queue billing --state ready --limit 20
pnpm cf-jobs retry <id>
pnpm cf-jobs retry --queue billing
pnpm cf-jobs clear --state reserved
pnpm cf-jobs prune --completed-hours 24 --failed-hours 168
```

Commands that change data ask for confirmation. In scripts and other non-interactive runs, pass `--yes`. Shared options include `--config`, `--db`, `--remote`, `--json`, `--jobs-table`, and `--failed-table`. To see the flags for one command, run `pnpm cf-jobs <command> --help`.

### Out-of-band development worker

The in-memory dev queue runs a job at once, inside the Nuxt process. If the request must return before durable work starts, run `cf-jobs work`. This matters most when you test WebSocket progress:

```bash
# terminal 1
pnpm nuxt dev

# terminal 2
pnpm cf-jobs work
pnpm cf-jobs work --queue sync-critical
pnpm cf-jobs work --once
pnpm cf-jobs work --interval 1000
```

The command polls `POST /__cf-jobs/work`, a development-only route, then runs the app's real queue consumer in the dev process. While the poller holds its short lease, durable rows wait for it. If you stop the command, the normal in-memory queue resumes after about 15 seconds.

Concurrency and batch size come from the Wrangler consumer config. Values on `cfJobs.queues` override them in development. When neither source sets a value, the dev worker uses one lane and batches of 10.

`work` defers only durable jobs, because lightweight messages have no D1 row to drain. The route exists only in development, so use `work` beside `nuxt dev`.

### Read-only monitoring

`cf-jobs watch` streams one NDJSON object for every terminal dev job. Failures include the full stored exception.

```bash
pnpm cf-jobs watch
pnpm cf-jobs watch --failures-only
pnpm cf-jobs watch --queue crawl
pnpm cf-jobs watch --backfill 300
```

`watch` never drains jobs and never holds the worker lease. You can run it beside `cf-jobs work` or while the normal dev queue is active.

## Testing

The testing entry point has no Nitro dependency:

```ts
import {
  createFakeQueue,
  createJobTestHarness,
  createQueueTestHarness,
} from '@harlan-zw/nuxt-cf-jobs/testing'
```

### Run handlers inline

Use an inline registry for a small unit test, or pass `jobRegistry` from `#cf-jobs/app` inside a prepared Nuxt test:

```ts
import { defineJob, defineJobRegistry } from '@harlan-zw/nuxt-cf-jobs/server'
import { createJobTestHarness } from '@harlan-zw/nuxt-cf-jobs/testing'

const registry = defineJobRegistry([
  defineJob({
    name: 'order/ship',
    queue: 'standard',
    async handle(payload: { orderId: string }) {
      await shipOrder(payload.orderId)
    },
  }),
])

const h = createJobTestHarness(registry, {
  env: {},
  db: {},
  log: console,
})

const result = await h.runInline('order/ship', { orderId: 'A1' })
expect(result.success).toBe(true)
h.assertRan('order/ship')
h.assertNothingFailed()
```

Unhandled handler errors reject `runInline()`. Calls to `ctx.release()` and `ctx.fail()` are recorded for `assertReleased()` and `assertFailed()`.

### Record dispatched jobs

```ts
const fake = h.fakeJobs(['QUEUE_STANDARD'])

await myProducer(fake.env)

fake.assertSent('order/ship')
fake.assertSentTimes('order/ship', 1)
fake.assertSentOn('standard', 'order/ship')
fake.assertSentWithDelay('order/ship', 60)
fake.assertNotSent('email/send')
```

The recorder also provides `assertChained()` for continuations and `assertBatched()` for `sendBatch()` calls.

### Drive the queue on a virtual clock

`createQueueTestHarness()` covers producer, queue, consumer, handler, and delayed redelivery without real timers:

```ts
const q = createQueueTestHarness({
  registry,
  queues: { standard: 'QUEUE_STANDARD' },
})

await q.env.QUEUE_STANDARD.send({
  _task: 'order/ship',
  orderId: 'A1',
})

await q.work()
q.assertProcessed('order/ship')

q.advanceTime(30)
await q.runUntilEmpty()
q.assertNothingPending()
```

Raw queue messages need `_task: <job-name>`. You send through bindings such as `QUEUE_STANDARD`. Assertions use job names such as `order/ship`.

To test your own queue processor, pass a `consumer` callback. In that mode, assert against your own store and against queue mechanics such as `assertRetried()`, `assertDispatched()`, and `pending()`.

### Test setup

`@nuxt/test-utils` resolves `#cf-jobs/app`, `#cf-jobs/server`, and `nitropack/runtime` for you. This is the simplest way to test real generated jobs.

For plain Vitest, run `nuxt prepare`, alias `#cf-jobs/app` to `.nuxt/cf-jobs/registry.js`, and provide a `nitropack/runtime` identity stub if your test imports the server barrel. The package's own [`vitest.config.ts`](./vitest.config.ts) shows the complete setup.

## Configuration reference

### Module options

| Option | Default | Description |
| --- | --- | --- |
| `queues` | `{}` | Logical queue names mapped to bindings or queue option objects. |
| `defaultQueue` | None | Queue used when a job omits `queue`. |
| `jobsDir` | `server/jobs` | `true` to discover `server/jobs` in the app and every extended layer, or one path or an array resolved from the Nuxt root. |
| `jobsPattern` | `**/*.ts` | Glob used inside each jobs directory. |
| `jobsIgnore` | Private, declaration, test, and spec files | Extra ignore globs. |
| `tasksDir` | Disabled | `true`, a path, or paths used to discover Nitro tasks. |
| `tasksPattern` | `**/*.ts` | Glob used inside each task directory. |
| `tasksIgnore` | Private, declaration, test, and spec files | Extra task ignore globs. |
| `scheduledTasks` | Production only | Override local scheduled task execution. |
| `broadcast` | `false` | Enable the default WebSocket route or provide route and Durable Object settings. |
| `reconcile` | Enabled | Configure or disable durable recovery. |
| `validateWrangler` | `true` | Compare module queues and crons with Wrangler config. |
| `wranglerPath` | Auto-detected | Explicit Wrangler config path relative to the Nuxt root. |
| `registryAlias` | `#cf-jobs/app` | Add another alias for the generated registry. |

Queue option objects accept `binding`, `queueName`, `jobType`, `maxBatchSize`, `maxBatchTimeout`, `maxConcurrency`, `maxRetries`, `retryDelay`, `deadLetterQueue`, and `deadLetterQueueBinding`.

In production, the Wrangler config sets consumer batching, concurrency, retries, and dead-letter routing. Matching values in `cfJobs.queues` help validation and configure the out-of-band dev worker.

## Imports

Inside a Nuxt app, use `#cf-jobs/app` for the generated registry and `#cf-jobs/server` for runtime helpers.

Published package subpaths:

| Import | Contents |
| --- | --- |
| `@harlan-zw/nuxt-cf-jobs` | Nuxt module. |
| `@harlan-zw/nuxt-cf-jobs/server` | Server runtime, registry, durable jobs, dispatch, and scheduling. |
| `@harlan-zw/nuxt-cf-jobs/cloudflare` | Cloudflare-specific metrics helpers. |
| `@harlan-zw/nuxt-cf-jobs/d1` | D1 repository adapter for non-Nuxt contexts. |
| `@harlan-zw/nuxt-cf-jobs/schema` | Drizzle table definitions for non-Nuxt contexts. |
| `@harlan-zw/nuxt-cf-jobs/sentry` | Sentry request scope adapter for queue handlers. |
| `@harlan-zw/nuxt-cf-jobs/testing` | Nitro-free queue fakes and test harnesses. |

## Development

```bash
pnpm test
pnpm test:nitro
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
```

`test` runs the unit project. `test:nitro` runs the generated registry in a real Nuxt server. `test:e2e` starts Wrangler fixtures and exercises the Cloudflare Queues and D1 round trip through workerd.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-cf-jobs/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-cf-jobs/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-cf-jobs

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-cf-jobs.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-cf-jobs

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-cf-jobs/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
