# nuxt-cf-jobs

Nuxt module for typed Cloudflare Queue jobs. Scans `server/jobs`, generates a typed registry, exposes runtime helpers for sending/consuming queue messages and persisting durable jobs in D1.

## Downstream consumers

Both linked via `link:../../pkg/nuxt-cf-jobs` (or deeper). Changes here ship to them immediately, so check both before deleting or renaming public surface.

### `~/sites/gscdump.com`

- Single Nuxt app. `cfJobs.queues` = `sync-critical`, `sync-standard`, `sync-extended`, `webhook`.
- Heavy user of the **durable / outbox** path. Pulls these directly from `#cf-jobs/server`:
  - `claimDurableJob`, `completeDurableJob`, `failDurableJob`, `releaseDurableJob`
  - `dispatchRegisteredJob`, `dispatchDurableJobBatch`, `dispatchDurableJobContinuations`
  - `prepareDurableJob`, `enqueueDurableJob`
  - `getDurableJobContinuationsForStage`, `parseDurableJobContinuation`, `serializeDurableJobContinuation`
  - `createQueuePublisher`, `resolveQueueBindingName`, `resolveJobRetryDelay`, `resolveJobMaxAttempts`
- Imports the drizzle table defs from the **`nuxt-cf-jobs/schema`** subpath in `database/main/schema.ts` (a drizzle-kit context where the `#cf-jobs/*` nuxt alias doesn't resolve and pulling `./server` would drag `nitropack/runtime`).
- Also uses `#cf-jobs/app` (`jobRegistry`, `jobs`, `JobName`, `JobPayload`).
- Passes `cfJobs.defaultQueue` (supported in `ModuleOptions`).

### `~/sites/nuxtseo.com/apps/pro`

- Monorepo app composed of layers (`pro-dataforseo`, `pro-gsc`, `pro-indexing`, `pro-perf`, `pro-reports`, `pro-saas`, `pro-saas-billing`).
- Configures multi-`jobsDir` with paths into each layer — relies on `jobsDir: string[]` resolving relative to root.
- Queues: `billing`, `dataforseo`, plus more.
- Indirect consumers also at `~/sites/nuxtseo.com` (root vitest config).

## Implications for changes

- **The public surface is curated in `runtime/server/index.ts`, not `export *`.** The barrel re-exports the durable/outbox, d1, dispatch, policy, registry, scheduled, schema, testing and types modules wholesale (gscdump imports those lifecycle/dispatch helpers individually — don't delete/rename without grepping both sites). `queue.ts` is the exception: only `resolveQueueBindingName`, `resolveNitroTaskEnv`, `createJobQueue`, `defineCfJobsQueues`, `exponentialBackoff` and the `CF_QUEUE_MAX_*` constants are public; its transport/binding/DLQ/consumer helpers are module-private. `dev.ts`, `payload.ts`, `internal.ts` are internal-only. Tests of private helpers import them from the module path (`../src/runtime/server/queue`), not the barrel.
- **`exports` map = `.`, `./server`, `./d1`, `./schema`.** `./server` (the curated umbrella) is the contract for in-nitro consumers; `./d1` and `./schema` exist only for non-nuxt contexts (drizzle-kit config, the `cf-jobs` CLI's migration path) where the `#cf-jobs/*` alias is dead. The old `./durable`, `./queue`, `./scheduled`, `./testing` subpaths were removed (0 consumers; all reachable via `./server`) — **SemVer-breaking, note in the next release**.
- **`jobsDir` must keep supporting `string[]` with relative paths from app root** (nuxtseo layers).
- Auto-imports were narrowed to `defineJob` only — both consumers already use explicit imports from `#cf-jobs/server`, so this is safe.
- Build-time wrangler/queue reconciliation lives in `wrangler.ts` (`reconcileQueues`, `buildQueueExpectations`, `normalizeNitroQueues`, `mergeWranglerSources`); `module.ts` is thin wiring over it. Keep new merge/normalize/cross-check logic there so it stays unit-testable (`tests/wrangler-reconcile.test.ts`).
