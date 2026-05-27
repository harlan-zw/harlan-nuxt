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
- Also uses `#cf-jobs/app` (`jobRegistry`, `jobs`, `JobName`, `JobPayload`).
- Passes `cfJobs.defaultQueue` (supported in `ModuleOptions`).

### `~/sites/nuxtseo.com/apps/pro`

- Monorepo app composed of layers (`pro-dataforseo`, `pro-gsc`, `pro-indexing`, `pro-perf`, `pro-reports`, `pro-saas`, `pro-saas-billing`).
- Configures multi-`jobsDir` with paths into each layer — relies on `jobsDir: string[]` resolving relative to root.
- Queues: `billing`, `dataforseo`, plus more.
- Indirect consumers also at `~/sites/nuxtseo.com` (root vitest config).

## Implications for changes

- **Internal helpers in `runtime/server/*` are public.** gscdump imports lifecycle/dispatch helpers individually. Don't delete or rename without grepping both sites.
- **The `#cf-jobs/server` alias is the contract.** Subpath exports (`/durable`, `/d1`, etc.) exist but consumers use the umbrella alias.
- **`jobsDir` must keep supporting `string[]` with relative paths from app root** (nuxtseo layers).
- Auto-imports were narrowed to `defineJob` only — both consumers already use explicit imports from `#cf-jobs/server`, so this is safe.
