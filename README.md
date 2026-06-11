<h1>nuxt-cf-jobs</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Typed Cloudflare Queue jobs for Nuxt, with Laravel-style ergonomics.

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

- 📁 **File-based jobs**: drop a `defineJob` in `server/jobs`, get a generated typed registry, no central list to maintain.
- 🔒 **End-to-end types**: `JobName` and `JobPayload` are inferred per job, so unknown names and wrong payloads fail at compile time.
- ☁️ **Cloudflare Queues**: send to queue bindings and consume batches through a Nitro hook, with per-queue routing.
- 🗄️ **Durable D1 jobs**: persist a record before enqueue so work survives restarts and delivery gaps, with retry, release, and DLQ.
- ⏰ **Scheduled tasks**: co-locate a cron with its handler; `nitro.tasks`, `scheduledTasks`, and Cloudflare `triggers.crons` are derived from it.
- 🧪 **Laravel-style testing**: run handlers inline, fake the queue, drain the outbox, or drive the whole `queue:work` loop on a virtual clock.
- 🛠️ **`cf-jobs` CLI**: `artisan queue:*`-style status, retry, flush, and migrate against local or remote D1, plus a `work` dev worker that runs durable jobs out-of-band so WebSockets stream live progress in `nuxt dev`.

## Install

```bash
pnpm add nuxt-cf-jobs
```

Add the module and map your logical queue names to Cloudflare bindings:

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

The string form (`default`) uses the logical name as the Cloudflare queue name. The object form lets the Cloudflare queue name differ from the logical name.

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

Job names come from the file path, so this file registers as `sync/table`. Duplicate derived names fail during template generation. Private and test files are ignored by default:

```ts
jobsIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts']
```

## Typed Registry

The generated registry is available as `#cf-jobs/app`:

```ts
import type { JobName, JobPayload } from '#cf-jobs/app'
import { buildJobPayload, getJobDefinition, getQueue, prepareJob } from '#cf-jobs/app'

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

TypeScript rejects unknown job names and invalid payload shapes wherever the payload type can be inferred from the job definition.

## Send Jobs

Use `getQueue(event, jobDefinition)` inside server routes, event handlers, or Nitro plugins, anywhere you have an `H3Event` or a Cloudflare env-like source:

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

`queue.send()` returns `false` when the configured Cloudflare binding is unavailable, so development and unsupported runtimes fail explicitly instead of throwing.

In `nuxt dev`, the module installs a dev-only Nitro plugin that builds in-memory queue bindings from your `cfJobs.queues` config and forwards messages to the `cloudflare:queue` hook.

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

`registerQueueConsumer()` wires the generated registry and `runtimeConfig.cfJobs.queues` for you; you provide the application-specific context. Other options:

```ts
registerQueueConsumer(nitroApp, {
  createContext,
  getJobId: ({ payload }) => String(payload.jobId),
  getSiteId: payload => typeof payload.siteId === 'string' ? payload.siteId : null,
  getUserId: payload => typeof payload.userId === 'number' ? payload.userId : null,
  retryDelaySeconds: () => 30,
  onInvalidPayload: input => console.warn(input.error),
  onDispatchError: input => console.error(input.error),
})
```

Without `getJobId`, the consumer uses `payload.jobId` when present, otherwise a stable serialized payload ID.

## Durable D1 Jobs

For work that should survive process restarts or queue delivery issues, persist a durable record first, then enqueue a lightweight queue message:

```ts
import { prepareJob } from '#cf-jobs/app'
import { createD1DurableJobRepository, createQueuePublisher, enqueueDurableJob } from '#cf-jobs/server'

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env as {
    DB: D1Database
    QUEUE_DEFAULT: Queue
  }

  const repository = createD1DurableJobRepository(env.DB)
  await repository.migrate()

  const publisher = createQueuePublisher(env, queue =>
    queue === 'default' ? 'QUEUE_DEFAULT' : undefined)

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
import { jobRegistry } from '#cf-jobs/app'
import { createD1DurableJobRepository, runDurableJobMessage } from '#cf-jobs/server'

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

`createD1DurableJobRepository()` exposes `migrate`, `insertJob`, `claimJob`, `completeJob`, `failJob`, `releaseJob`, `findDispatchableJobs`, `findStaleReservedJobs`, `releaseStaleReservedJobs`, and `toDispatchableJob`.

## Scheduled Tasks (cron)

Queue jobs handle per-request deferred work; **scheduled tasks** handle cron work. `defineScheduledTask` co-locates the cron schedule with its handler, and the module derives `nitro.tasks`, `nitro.scheduledTasks`, and the Cloudflare `triggers.crons` from it, so there is no central list to keep in sync (and no way for the three to drift apart).

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
    // ...or be explicit: tasksDir: ['server/tasks', '../some-layer/server/tasks']
  },
})
```

Notes:

- `name` and `cron` must be **string literals**. The module reads them statically at build time, without executing the file (which usually imports DB/server utils that won't load outside nitro). Computed values are skipped with a warning.
- Plain nitro `defineTask` files in the same dirs are still registered (runnable via `runTask`), just not scheduled.
- `nitro.scheduledTasks` is populated only outside dev by default, so crons don't fire locally. Override with `cfJobs.scheduledTasks: true | false`. The deploy-only `triggers.crons` is always written.
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
pnpm cf-jobs retry <id>                   # artisan queue:retry, re-queue a failed job
pnpm cf-jobs retry --queue billing        # re-queue a whole queue's failures
pnpm cf-jobs forget <id>                  # artisan queue:forget
pnpm cf-jobs flush                        # artisan queue:flush, delete all failed jobs
pnpm cf-jobs clear --state reserved       # artisan queue:clear, drop active jobs (e.g. stuck reservations)
pnpm cf-jobs migrate                      # create the job tables/indexes in D1
```

Every command accepts `--config <wrangler path>`, `--db <binding>`, `--remote`, `--json`, and `--jobs-table` / `--failed-table` overrides. `status` flags queues whose oldest ready job is lagging and reservations stuck for more than five minutes (a crashed or timed-out consumer). Run `cf-jobs <command> --help` for the full argument list.

`cf-jobs` shells out to `wrangler`, resolving the binary from `node_modules/.bin` and falling back to `wrangler` on `PATH` (override with `CF_JOBS_WRANGLER_BIN`).

### Dev worker (`cf-jobs work`)

In production the queue consumer is a separate Worker invocation, so a running job is naturally decoupled from the request that enqueued it. Under `nuxt dev` the in-memory dev queue runs a job the instant it's enqueued, in the same process, before a client has a chance to observe it. That hides the asynchronous behaviour you actually want to test, most painfully a WebSocket streaming live job progress: the job finishes before the socket is even connected.

`cf-jobs work` restores that decoupling. It is a long-running dev worker that drains durable jobs **out-of-band**, on its own clock, by driving the running dev server:

```bash
# in one terminal
pnpm nuxt dev

# in another: poll the dev server, run whatever durable jobs are ready
pnpm cf-jobs work
pnpm cf-jobs work --queue sync-critical   # only one logical queue
pnpm cf-jobs work --once                  # drain everything ready now, then exit (handy in scripts/CI)
pnpm cf-jobs work --interval 1000         # idle poll interval in ms (backs off to 5s); default 500
```

So a client connects to your WebSocket, enqueues a job (the request returns immediately, job persisted in D1), then `cf-jobs work` picks it up a tick later and runs it. Because the worker drives a dev-only endpoint (`POST /__cf-jobs/work`) that fires your app's registered `cloudflare:queue` consumer **in the dev process**, the job runs with the app's real context and an in-memory WebSocket broadcast reaches the connected client, exactly as it would in production via a Durable Object.

On a TTY it shows a **live dashboard** (repainted each tick) so you can watch jobs flow through: per-queue ready/lanes/done/failed, plus a table of recent outcomes with how long ago they ran and how long they took. Pass `--no-watch` for the append-only line log, or `--json` for one machine-readable line per interval (CI/scripts).

```
cf-jobs work · localhost:3030 · up 2m13s · 142 done · 1 failed · ~6/s

QUEUE        READY  LANES  DONE  FAIL
crawl           24    3/4    84     1
reports          0    0/1    18     0

recent
  JOB              QUEUE    AGO      TOOK / ERROR
✓ crawl/site-scan  crawl    12s ago  142ms
✓ crawl/site-scan  crawl    18s ago  98ms
✗ reports/weekly   reports  2m ago   DataForSEO 401 Unauthorized
```

**No flag or restart needed to switch modes.** While `cf-jobs work` is running, its polling tells the dev server to stop auto-running durable jobs and leave them in D1 for the worker (the poll refreshes a short in-process lease — no pid file, no env var). Stop the worker and, once the lease lapses (~15s), the dev queue resumes running jobs immediately as before. So you opt into the realistic out-of-band lifecycle simply by starting the worker, and opt out by stopping it.

**One poller, demand-driven fan-out.** A single `cf-jobs work` process reads a cheap per-queue demand snapshot each interval and opens concurrent drain *lanes* sized to each queue's wrangler `max_concurrency` (`LANES` = in-flight / budget). Each lane is **self-sustaining**: the moment a batch response returns with more work, it pulls the next one — throughput is gated by how fast the dev server drains, not by the poll clock. A long job in one queue occupies one of its lanes and never stalls the others, and an idle system backs the snapshot poll off automatically. So a queue with `{ maxConcurrency: 4, maxBatchSize: 10 }` drains 10-at-a-time across 4 concurrent lanes, like its production consumer.

### Agent monitoring (`cf-jobs watch`)

`cf-jobs watch` is a **read-only** companion for agents (or any tooling) that need to observe jobs in real time and react to failures. It streams one NDJSON event per terminal job to stdout, with the **full untruncated exception** on failures so an agent can read the stack and fix the issue:

```bash
cf-jobs watch                    # every completed/failed job as it happens
cf-jobs watch --failures-only    # only failures (full stack traces)
cf-jobs watch --queue crawl      # one queue
cf-jobs watch --backfill 300     # also replay the last 5 minutes on start
```

```json
{"ts":"2026-06-11T07:16:03.000Z","event":"failed","id":"j1","queue":"crawl","type":"crawl/site-scan","error":"Error: boom\n    at handler (x.ts:1:1)\n    at run (x.ts:2:2)"}
{"ts":"2026-06-11T07:16:05.000Z","event":"completed","id":"j2","queue":"crawl","type":"crawl/site-scan","durationMs":142}
```

Unlike `work`, `watch` never drains and never holds the lease (`lease=0`), so it's pure observation: it doesn't change which process runs your jobs. Run it alongside `cf-jobs work` (or on its own while jobs auto-run) and tail the stream.

Three things to know:

- This is a **`nuxt dev` companion, not a production worker.** It assumes one process, so the request that runs the job shares memory (and thus WebSocket maps) with the rest of the dev server. Under multi-isolate setups (e.g. `wrangler dev`) the broadcast can land in a different isolate. The `/__cf-jobs/work` endpoint is registered only in dev and is an unauthenticated job executor, so it is never built into a deployment.
- Deferral targets the **durable** path. While the worker holds the lease, a non-durable fire-and-forget `.send()` has no D1 row for the worker to find, so it won't run until you stop the worker. Use durable jobs (`enqueueDurableJob`) for anything you want the worker to drive.
- Unlike the D1-querying commands above, `work` talks HTTP to the running dev server. It takes `--url` (default `http://localhost:3000`), `--db <binding>` to disambiguate when several D1 bindings exist, and `--json` to emit one machine-readable line per active tick.

## Runtime Validation

The generated registry validates jobs at startup and fails loudly for invalid definitions, duplicate names, and missing or invalid queue names. Queue binding checks are available from `#cf-jobs/app`:

```ts
import { assertQueueBindings, validateQueueBindings } from '#cf-jobs/app'

const issues = validateQueueBindings()
assertQueueBindings()
```

## Testing Jobs

`createJobTestHarness(registry, options?)` gives Laravel-style ergonomics for testing jobs without a running queue or worker. It infers typed job names and payloads from the registry you pass.

### Test setup

`createJobTestHarness` lives on the **`nuxt-cf-jobs/testing`** subpath, which is itself nitropack-free. What you pair it with is not: your generated registry (`#cf-jobs/app`) and `defineJob` / `defineJobRegistry` (from `nuxt-cf-jobs/server`) transitively import `nitropack/runtime`, which only resolves inside a built Nuxt app. So:

- **Under `@nuxt/test-utils`** (recommended): nothing to configure. `#cf-jobs/app`, `#cf-jobs/server`, and `nitropack/runtime` all resolve.
- **Plain vitest**: alias the generated registry to its prepared location and stub `nitropack/runtime` with identity exports:

  ```ts
  // vitest.config.ts
  import { fileURLToPath } from 'node:url'

  export default {
    resolve: { alias: {
      // run `nuxi prepare` first so the generated registry exists:
      '#cf-jobs/app': fileURLToPath(new URL('./.nuxt/cf-jobs/registry.ts', import.meta.url)),
      // identity stub re-exporting defineTask / defineNitroPlugin / useRuntimeConfig:
      'nitropack/runtime': fileURLToPath(new URL('./tests/stubs/nitropack-runtime.ts', import.meta.url)),
    } },
  }
  ```

  The module's own [`vitest.config.ts`](./vitest.config.ts) applies the same alias and stub pattern to source.

### Build a harness

The fastest path is an **inline registry**, which needs no `#cf-jobs/app` resolution:

```ts
import { defineJob, defineJobRegistry } from 'nuxt-cf-jobs/server'
import { createJobTestHarness } from 'nuxt-cf-jobs/testing'

const registry = defineJobRegistry([
  defineJob({
    name: 'order/ship',
    queue: 'standard',
    async handle(payload: { orderId: string }, ctx) { /* ... */ },
  }),
])

const h = createJobTestHarness(registry, {
  env: {}, // opaque to the harness; surfaced as ctx.env
  db: {}, // your test double / drizzle instance; surfaced as ctx.db
  log: console,
})
```

To test your real jobs, pass `jobRegistry` from `#cf-jobs/app` instead (with the setup above). `env` / `db` / `log` are opaque to the harness and handed to each handler's `ctx`.

### Run a job inline (the `sync` driver)

`runInline` looks up the handler, builds the `_task` envelope, runs middleware and `handle`, and returns the result. Unhandled errors propagate so you can use `expect(...).rejects`. Assert on side effects (DB rows, sent mail, events):

```ts
it('ships the order', async () => {
  const res = await h.runInline('order/ship', { orderId: 'A1' })

  expect(res.success).toBe(true)
  expect(res.released).toBe(false) // handler did not call ctx.release()
  expect(res.failed).toBe(false) // handler did not call ctx.fail()
  // ...assert your side effects
})

// exercise retry / failure branches
const released = await h.runInline('order/ship', { orderId: 'A2' }, { attempt: 2 })
expect(released.delaySeconds).toBe(30)
```

The harness records every `runInline` / `drainOutbox` outcome, so you can assert what ran after the fact (Laravel's `assertFailed` / `assertNothingFailed`):

```ts
await h.runInline('order/ship', { orderId: 'A1' })
await h.runInline('order/ship', { orderId: 'A2', fail: true })

h.assertRan('order/ship') // ran and succeeded at least once
h.assertRan('order/ship', result => result.success)
h.assertFailed('order/ship') // a run called ctx.fail() (or threw)
h.assertReleased('order/ship') // a run called ctx.release()
// h.assertNothingFailed() // would throw here
```

### Assert what was dispatched (`Queue::fake()`)

`fakeJobs(bindings)` returns a recording fake env plus assertions. Spread `env` into whatever your producer reads from, run your code, then assert:

```ts
it('queues a confirmation email', async () => {
  const fake = h.fakeJobs(['QUEUE_STANDARD'])

  await myEndpoint({ env: fake.env })

  fake.assertSent('email/send')
  fake.assertSent('email/send', payload => payload.orderId === 'A1')
  fake.assertSentTimes('email/send', 1)
  fake.assertSentOn('standard', 'email/send')
  fake.assertSentWithDelay('email/send', 60) // queued with a 60s delay
  fake.assertNotSent('order/ship')

  // chains + batches (Laravel's assertPushedWithChain / Bus::assertBatched)
  fake.assertChained('order/ship', ['email/send']) // `then` continuation chain
  fake.assertBatched(names => names.length === 2) // jobs dispatched via sendBatch
})
```

### Drain the durable outbox once (`queue:work --once`)

`drainOutbox` claims durable records one at a time, runs each inline, and routes the outcome to `onComplete` / `onReleased` / `onFailed`. Wire `next` to your D1 (or in-memory) outbox; payloads are `JSON.parse`d by default:

The four callbacks are your own outbox functions (claim a record, then persist each outcome), not module exports:

```ts
const summary = await h.drainOutbox({
  next: () => claimNext(), // your "reserve the next durable record" query, or undefined when empty
  onComplete: record => markComplete(record),
  onReleased: (record, delaySeconds) => markReleased(record, delaySeconds),
  onFailed: (record, error) => markFailed(record, String(error)),
})

expect(summary).toEqual({ processed: 3, completed: 2, released: 0, failed: 1 })
```

### Run the whole queue (`queue:work`)

`createQueueTestHarness` drives the full pipeline in-process on a **virtual clock**: dispatch onto a producer binding, `work()` a pass like `queue:work --once`, `advanceTime()` to fire delayed/released/backoff retries, and `runUntilEmpty()` to drain everything including chained continuations. No real timers, fully deterministic.

```ts
import { createQueueTestHarness } from 'nuxt-cf-jobs/testing'

const q = createQueueTestHarness({
  registry, // inline, or jobRegistry from #cf-jobs/app
  queues: { critical: 'QUEUE_CRITICAL', standard: 'QUEUE_STANDARD' }, // logicalName: binding
})

// producer → queue → consumer → handler.
// A raw message body MUST carry `_task: <jobName>` alongside the payload fields;
// a message without `_task` is silently retried, not run.
q.env.QUEUE_CRITICAL.send({ _task: 'order/process', orderId: 'A1' })
await q.work()
q.assertProcessed('order/process')

// release/backoff redelivery
q.advanceTime(30)
await q.work()
q.assertReleased('order/process', { delay: 30 })
q.assertRetried('order/process', 1)

// drain a chain/continuation to completion
await q.runUntilEmpty()
q.assertNothingPending()
```

`env[binding]` and `send(binding, ...)` use the **binding** name (`QUEUE_CRITICAL`); the assertions use the **job name** (`order/process`). `queues` maps logical-queue to binding, matching your `cfJobs.queues` config.

By default the harness dispatches through the registry, so `assertProcessed` / `assertFailed` / `assertReleased` reuse the inline run log. Pass `consumer` to drive **your own** `cloudflare:queue` batch processor instead. In that mode the run-log assertions throw a clear error (they have nothing to read), so assert via your durable store plus the queue-mechanics helpers (`assertRetried`, `assertDispatched`, `pending()`):

```ts
const q = createQueueTestHarness({
  registry: jobRegistry,
  queues: { critical: 'QUEUE_CRITICAL' },
  consumer: (batch, env) => myConsumer(batch, env), // your real telemetry/DLQ/retry
})
```

The lower-level fakes (`createFakeQueue`, `createFakeQueueEnv`, `createQueueMessage`, `createQueueBatch`) live on the same `nuxt-cf-jobs/testing` subpath, for hand-wiring `processRegisteredQueueBatch`. Their producer contract (`send` / `sendBatch`, `delaySeconds`, per-message overrides) matches the dev polyfill (`createDevQueueRuntime`) and real Cloudflare Queues, so a passing fake-based test reflects dev and production producer behaviour. The module's own suite asserts that equivalence directly.

## Public Imports

Prefer the narrow subpaths:

```ts
import { createD1DurableJobRepository } from 'nuxt-cf-jobs/d1'
import { defineJob } from 'nuxt-cf-jobs/server'
import { createFakeQueue, createJobTestHarness } from 'nuxt-cf-jobs/testing'
```

Available package subpaths:

- `nuxt-cf-jobs`: the Nuxt module
- `nuxt-cf-jobs/server`: server runtime barrel (durable, queue, dispatch, registry)
- `nuxt-cf-jobs/testing`: test helpers (`createJobTestHarness`, `createQueueTestHarness`, `createFakeQueue*`), nitropack-free
- `nuxt-cf-jobs/d1`: D1 durable repository adapter (non-nuxt contexts)
- `nuxt-cf-jobs/schema`: Drizzle schema (non-nuxt contexts)

Inside a Nuxt app, prefer the generated aliases `#cf-jobs/server` (runtime helpers) and `#cf-jobs/app` (your typed registry).

## Tests

The suite runs as two vitest projects, plus an opt-in wrangler tier:

```bash
pnpm test       # unit project (happy-dom): runtime + test-helper specs
pnpm test:nitro # nitro project (*.nitro.test.ts): real Nuxt server via @nuxt/test-utils
pnpm typecheck
pnpm build
pnpm test:e2e   # wrangler/workerd round-trip (real queue consumer)
```

Three tiers of increasing fidelity:

- **unit**: fakes and harness, plus a producer-contract parity check (the fakes behave like the dev polyfill and Cloudflare) and the dev-polyfill to consumer delivery loop.
- **`test:nitro`**: the generated registry driven through the real runtime inside a built Nuxt server (nitropack v2), via `@nuxt/test-utils`.
- **`test:e2e`**: the real Cloudflare Queues/D1 round-trip over workerd, including the consumer delivery path. `registerQueueConsumer`'s runtime-config resolution only works under the Cloudflare runtime, so this tier is where it runs end to end.

`pnpm test:e2e` starts Wrangler fixtures and needs the local Cloudflare/Wrangler toolchain.

## License

Licensed under the [MIT license](https://github.com/harlan-zw/nuxt-cf-jobs/blob/main/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/nuxt-cf-jobs/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/nuxt-cf-jobs

[npm-downloads-src]: https://img.shields.io/npm/dm/nuxt-cf-jobs.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/nuxt-cf-jobs

[license-src]: https://img.shields.io/github/license/harlan-zw/nuxt-cf-jobs.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/nuxt-cf-jobs/blob/main/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
