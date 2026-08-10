<h1>@harlanzw/nuxt-cf-jobs</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Typed Cloudflare Queue jobs for Nuxt, with Laravel-style ergonomics.

Status: experimental. APIs may change before the first scoped release.

<p align="center">
<table>
<tbody>
<td align="center">
<sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br> Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub><br>
</td>
</tbody>
</table>
</p>

## Features

- 📁 **File-based jobs:** put a `defineJob` file in `server/jobs` and the module builds the registry.
- 🔒 **Typed dispatch:** job names, payloads, queues, and broadcast messages are inferred from your files.
- ☁️ **Cloudflare Queues:** route jobs across multiple producer bindings and consume them through Nitro's `cloudflare:queue` hook.
- 🗄️ **Optional D1 durability:** persist jobs before dispatch, recover missed sends, track attempts, and keep failed jobs.
- ⏰ **Scheduled tasks:** declare the cron beside the task and generate Nitro and Cloudflare scheduling config from it.
- 📡 **Realtime progress:** publish job and batch events over Nitro WebSockets and a Durable Object.
- 🧪 **Queue test harnesses:** run jobs inline, record dispatches, or drive retries on a virtual clock.
- 🛠️ **Operations CLI:** inspect, retry, prune, and migrate local or remote D1 job tables.

## Quick start

The basic path sends a typed message directly to Cloudflare Queues. D1 is optional and covered under [Durable jobs](#durable-jobs).

### 1. Install the module

```bash
pnpm add @harlanzw/nuxt-cf-jobs
```

Map each logical queue name to the binding exposed by Cloudflare:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@harlanzw/nuxt-cf-jobs'],
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

Jobs are scanned from `server/jobs` by default. Private files, declarations, and test files are ignored.

### 2. Configure Cloudflare

Merge matching producers, consumers, and observability settings into the `wrangler.jsonc` used by your Nuxt deployment. See Cloudflare's [Queues configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/) and [Workers observability](https://developers.cloudflare.com/workers/observability/) docs for the full set of options.

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

Choose and test a real `compatibility_date` before deploying. After changing bindings, regenerate Worker types:

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

Use string literals for `name` and `queue`. The module extracts routing metadata without executing the job file. An explicit `name` wins; the path relative to `jobsDir` is the generation fallback. Duplicate names stop the build.

Useful job options include:

| Option | Purpose |
| --- | --- |
| `input` | Validate payloads with a `safeParse()` compatible schema. |
| `tries` | Set the total attempt limit. `maxAttempts` is supported as an alias. |
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

The consumer owns `ack()` and `retry()`. Your `ctx.release()` and `ctx.fail()` implementations only record the requested action on `control`.

By default, the consumer uses `payload.jobId` as the runtime job ID. When it is absent, it derives a stable ID from the payload. Override this with `getJobId` when your payload has another identifier.

### 5. Dispatch a job

The generated `#cf-jobs/app` registry keeps the name and payload connected:

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

`getJobDefinition()` returns static routing and literal policy metadata without loading the job module. It does not include executable fields such as `handle`, `input`, or `uniqueId`. Use `loadJobDefinition()` when you need the full definition. The durable `prepareJob()` helper does this automatically. Jobs with `broadcast` also generate `JobBroadcastMessage<Name>` and `JobBroadcastEnvelope<Name>` types.

Runtime validation is available when you want to fail a custom startup check:

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

Both modes use the same `defineJob` files and generated types. Cloudflare Queues provide at-least-once delivery, so handlers should be safe to run again. The durable path adds a D1 claim before each run and keeps the lifecycle visible to the CLI.

## Durable jobs

### Add D1

Add a D1 binding to Wrangler alongside the queues:

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

Create the local tables, then apply the same migration remotely when you are ready:

```bash
pnpm cf-jobs migrate
pnpm cf-jobs migrate --remote
```

### Create the runtime

Keep runtime construction in one server utility so the queue consumer and producers share the same bindings and context:

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

Use this plugin instead of the lightweight `registerQueueConsumer()` plugin from the quick start. Registering both would process the same hook twice.

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

The generated `prepareJob()` loads the full job definition, validates the payload, resolves the queue, applies attempts and uniqueness, and checks the serialized payload against the durable D1 storage limit before inserting anything.

### Recovery

The module registers `cf-jobs:reconcile` by default. Every two minutes it reclaims stale reservations, re-dispatches older due rows that have no queue message, and closes orphaned batches when it has enough terminal evidence.

```ts
export default defineNuxtConfig({
  cfJobs: {
    reconcile: {
      d1Binding: 'DB',
      terminalFailureContext: './server/cf-jobs-reconcile-context.ts',
      staleSeconds: 300,
      orphanedSeconds: 600,
      redeliveryGraceSeconds: 120,
      orphanedBatchSeconds: 7 * 86400,
      limit: 100,
    },
    // Set false only when the app owns durable recovery.
    // reconcile: false,
  },
})
```

Pin `d1Binding` when the Worker exposes more than one D1-like binding.

`terminalFailureContext` points to an application module exporting
`createReconcileJobContext`. Configure it when job definitions have `failed`
callbacks: an isolate may terminate on its final claim, so the stale reaper must
be able to reconstruct application services after it commits the `failed_jobs`
row. Without the adapter, durable evidence and an explicit error log remain, but
the package cannot safely invent the application's database and logger context.

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

Add a job-specific event when its lifecycle changes:

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

You can also publish from arbitrary server code with `publishCfJobsBroadcast()`. Protect private channels with the authorization hook:

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

`tasksDir: true` scans `server/tasks` in the app and every extended Nuxt layer. Pass a path or path array when you want explicit directories.

- `name` and `cron` must be string literals because they are read at build time.
- `cron` accepts one expression or an array. Cloudflare Cron Triggers run in UTC.
- Plain Nitro `defineTask` files in the same directories are registered for manual use.
- App task discovery is opt-in. The built-in recovery task is separate and remains enabled unless `reconcile: false`.
- Scheduled execution is disabled during development by default. Set `scheduledTasks: true` to exercise crons locally.

If your Wrangler file already contains `triggers.crons`, the module checks it for drift and writes `.nuxt/cf-jobs/crons.suggested.toml`.

## CLI

The `cf-jobs` binary reads the durable D1 tables through Wrangler. Local D1 is the default; add `--remote` for the deployed database.

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

Mutating commands ask for confirmation. Pass `--yes` for scripts and other non-interactive runs. Shared options include `--config`, `--db`, `--remote`, `--json`, `--jobs-table`, and `--failed-table`. Run `pnpm cf-jobs <command> --help` for command-specific flags.

### Out-of-band development worker

The in-memory dev queue normally runs a job immediately in the Nuxt process. Start `cf-jobs work` when you need the request to return before durable work begins, especially when testing WebSocket progress:

```bash
# terminal 1
pnpm nuxt dev

# terminal 2
pnpm cf-jobs work
pnpm cf-jobs work --queue sync-critical
pnpm cf-jobs work --once
pnpm cf-jobs work --interval 1000
```

The command polls `POST /__cf-jobs/work`, a development-only route, then runs the app's real queue consumer in the dev process. While the poller holds its short lease, durable rows wait for it. Stop the command and the normal in-memory queue resumes after roughly 15 seconds.

Concurrency and batch size come from the Wrangler consumer config. Values on `cfJobs.queues` override them in development. When neither source sets a value, the dev worker uses one lane and batches of 10.

`work` only defers durable jobs because lightweight messages have no D1 row to drain. It is a `nuxt dev` companion, not a production Worker.

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
} from '@harlanzw/@harlanzw/nuxt-cf-jobs/testing'
```

### Run handlers inline

Use an inline registry for a small unit test, or pass `jobRegistry` from `#cf-jobs/app` inside a prepared Nuxt test:

```ts
import { defineJob, defineJobRegistry } from '@harlanzw/@harlanzw/nuxt-cf-jobs/server'
import { createJobTestHarness } from '@harlanzw/@harlanzw/nuxt-cf-jobs/testing'

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

Raw queue messages need `_task: <job-name>`. Bindings such as `QUEUE_STANDARD` are used to send; assertions use job names such as `order/ship`.

Pass a `consumer` callback to exercise your own queue processor. In that mode, assert against your store plus queue mechanics such as `assertRetried()`, `assertDispatched()`, and `pending()`.

### Test setup

`@nuxt/test-utils` resolves `#cf-jobs/app`, `#cf-jobs/server`, and `nitropack/runtime` for you. This is the simplest way to test real generated jobs.

For plain Vitest, run `nuxt prepare`, alias `#cf-jobs/app` to `.nuxt/cf-jobs/registry.js`, and provide a `nitropack/runtime` identity stub if your test imports the server barrel. The package's own [`vitest.config.ts`](./vitest.config.ts) shows the complete setup.

## Configuration reference

### Module options

| Option | Default | Description |
| --- | --- | --- |
| `queues` | `{}` | Logical queue names mapped to bindings or queue option objects. |
| `defaultQueue` | None | Queue used when a job omits `queue`. |
| `jobsDir` | `server/jobs` | One directory or an array, resolved from the Nuxt root. |
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

Wrangler remains the production source for consumer batching, concurrency, retries, and dead-letter routing. Matching values in `cfJobs.queues` help validation and configure the out-of-band dev worker.

## Imports

Inside a Nuxt app, use `#cf-jobs/app` for the generated registry and `#cf-jobs/server` for runtime helpers.

Published package subpaths:

| Import | Contents |
| --- | --- |
| `@harlanzw/nuxt-cf-jobs` | Nuxt module. |
| `@harlanzw/nuxt-cf-jobs/server` | Server runtime, registry, durable jobs, dispatch, and scheduling. |
| `@harlanzw/nuxt-cf-jobs/cloudflare` | Cloudflare-specific metrics helpers. |
| `@harlanzw/nuxt-cf-jobs/d1` | D1 repository adapter for non-Nuxt contexts. |
| `@harlanzw/nuxt-cf-jobs/schema` | Drizzle table definitions for non-Nuxt contexts. |
| `@harlanzw/nuxt-cf-jobs/testing` | Nitro-free queue fakes and test harnesses. |

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

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-cf-jobs/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlanzw%2Fnuxt-cf-jobs/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlanzw/nuxt-cf-jobs

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlanzw%2Fnuxt-cf-jobs.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlanzw/nuxt-cf-jobs

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-cf-jobs/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
