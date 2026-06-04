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

- **The public surface is curated in `runtime/server/index.ts`, not `export *`.** The barrel re-exports the durable/outbox, d1, dispatch, errors, policy, registry, result, scheduled, schema and types modules wholesale (gscdump imports those lifecycle/dispatch helpers individually — don't delete/rename without grepping both sites).
- **Typed-error model (Effect-inspired, no dep): `errors.ts` + `result.ts`.** `errors.ts` is the `JobError` tagged union (`_tag`-discriminated: `no-task`, `handler-not-found`, `invalid-payload`, `payload-too-large`, `no-route`, `unknown-continuation`, `invalid-continuation`, `continuation-queue-mismatch`, `handler-threw`) with `jobErrors.*` constructors + `formatJobError` / `jobErrorToException` / `isJobError`. `result.ts` is the `Result<A,E>` = `Ok|Err` primitive (`ok`/`err`/`isOk`/`isErr`/`mapResult`/`mapErr`/`matchResult`/`unwrapResult`). `DispatchResult.error` is now a `JobError` (the old `handlerNotFound`/`invalidPayload`/`validationError` flags are gone — discriminate on `error._tag`; `error.cause` carries the old `validationError`). `prepareDurableJobResult` is the errors-as-values core (`prepareDurableJob` is the throwing wrapper over it); `validateDurableJobContinuations` returns `JobError | undefined` instead of throwing. `runDurableJobMessage` and `enqueueDurableJob` now return discriminated unions (`RunDurableJobMessageResult` keyed on `status`, with a distinct `errored` for handler defects vs `released` for deliberate `ctx.release()`; `EnqueueDurableJobResult` = `enqueued | duplicate | not-dispatched | dispatch-failed`) instead of `{ status, error?: unknown }` / `{ inserted, dispatched, error? }` bags. **Breaking; downstream updated in lockstep:** gscdump's `job-consumer`/`job-dispatcher` (local `DispatchResult.error` retyped + `formatJobError`) and nuxtseo-pro's `layers/saas/server/utils/cf-jobs-durable.ts` (`dispatch.error` → `formatJobError`). Both apps ignore `enqueueDurableJob`'s return (`.catch()` only) and have no `runDurableJobMessage` consumers, so those reshapes needed no app edits. Note in next release. `queue.ts` is the exception: only `resolveQueueBindingName`, `resolveNitroTaskEnv`, `createJobQueue`, `defineCfJobsQueues`, `exponentialBackoff` and the `CF_QUEUE_MAX_*` constants are public; its transport/binding/DLQ/consumer helpers are module-private. `testing.ts` is **no longer** on the barrel — it ships on its own `#cf-jobs/testing` subpath (nitropack-free, test-only) so importing the harness never drags the barrel's `scheduled` → `nitropack/runtime` edge. `dev.ts`, `payload.ts`, `internal.ts` are internal-only. Tests of private helpers import them from the module path (`../src/runtime/server/queue`), not the barrel.
- **`exports` map = `.`, `./server`, `./d1`, `./schema`, `./testing`.** `./server` (the curated umbrella) is the contract for in-nitro consumers; `./d1` and `./schema` exist only for non-nuxt contexts (drizzle-kit config, the `cf-jobs` CLI's migration path) where the `#cf-jobs/*` alias is dead. `./testing` (re-added after a prior removal) carries the `createJobTestHarness` / `createFakeQueue*` helpers; it depends only on `dispatch`/`registry`/`types`, so it loads in plain vitest without the `nitropack/runtime` stub. The old `./durable`, `./queue`, `./scheduled` subpaths stay removed (0 consumers; all reachable via `./server`) — **SemVer-breaking, note in the next release; moving the test helpers off `./server` to `./testing` is breaking too**.
- **`jobsDir` must keep supporting `string[]` with relative paths from app root** (nuxtseo layers).
- Auto-imports were narrowed to `defineJob` only — both consumers already use explicit imports from `#cf-jobs/server`, so this is safe.
- Build-time wrangler/queue reconciliation lives in `wrangler.ts` (`reconcileQueues`, `buildQueueExpectations`, `normalizeNitroQueues`, `mergeWranglerSources`); `module.ts` is thin wiring over it. Keep new merge/normalize/cross-check logic there so it stays unit-testable (`tests/wrangler-reconcile.test.ts`).
- **Tests run as two vitest `projects`** (`vitest.config.ts`): `unit` (happy-dom, all `tests/**/*.test.ts`, resolves runtime from source via `#cf-jobs/server` + `#cf-jobs/testing` aliases plus the `nitropack/runtime` stub) and `nitro` (`tests/**/*.nitro.test.ts`, node env, config in `tests/vitest.nitro.config.ts`). Nitro integration tests use `@nuxt/test-utils/e2e` `setup` + `$fetch` against `tests/fixtures/nuxt-demo` — the real Nuxt build under **nitropack v2** (do NOT use nitro-test-utils, which is nitro v3). Scripts: `test`/`test:unit` → unit, `test:nitro` → nitro, `test:e2e` → the wrangler/workerd round-trip tier (still the only thing that runs the real queue consumer).
