# Migration to 0.1.0

Every package in this repository moves to `0.1.0` together. All eight carry breaking changes.

## Why 0.1.0 and not another patch

Under semver, `^0.0.18` resolves to exactly `0.0.18`. A caret cannot widen a `0.0.x` range, so
cross-package dependencies always pinned one exact version, and a consumer installing two of
these packages installed two copies of a third. From `0.1.0`, `^0.1.0` accepts every later
`0.1.x`, so the duplicate installs stop.

## Order of work

1. Raise Node to 22.12 or later, and vite to 8. Both are checked at install time.
2. Update all eight packages together. They share cross-dependencies.
3. Work through the per-package sections below.
4. Run a build. Several changes now warn or fail where they used to pass in silence.

## Repository-wide

### Node and vite

- `@harlan-zw/comark-content` now needs Node `>=22.12.0`. Node 22.0 to 22.11 fails the engines
  check. The old `<27` upper bound is gone, so Node 27 is allowed.
- `vite` moved to `peerDependencies` (`^8.0.0`) in `nuxt-cf-jobs`, `nuxt-domain-events`,
  `nuxt-dx`, `nuxt-use-query` and `nuxt-wide-events`. Nuxt 4.5 or later resolves vite 8. If a
  lockfile pins vite 7, run `pnpm up vite@^8`. A vite 7 tree now reports an unmet peer instead
  of installing a second vite copy.

## @harlan-zw/nuxt-cloudflare

Whose config wins changed. The authored root `wrangler.jsonc`, `wrangler.json` or
`wrangler.toml` now outranks the module defaults. No consumer needs a code change for the fix
itself, but every consumer ships different values, and the workarounds below can go.

- **harlanzw.com** and **mdream.dev**: both now ship `observability.logs.head_sampling_rate: 1`
  from the authored file, not `0.01`. Log volume rises to the rate the file already asks for.
  Set `0.01` in `wrangler.jsonc` to keep the old rate. Both also ship
  `upload_source_maps: true`, so the `source-maps-disabled` warning stops. If the authored file
  declares `routes` or `route`, the generated config now sets `workers_dev: false`. Set
  `workers_dev: true` to keep the workers.dev endpoint.
- **request-indexing**: the generated config keeps only `nodejs_compat_v2`, with no
  `nodejs_compat` beside it. Delete the workaround at `nuxt.config.ts:229`. Authored
  `observability`, `upload_source_maps`, `placement` and `preview_urls` now reach the
  deployment.
- **unlighthouse.dev**: delete the `no_nodejs_compat_v2` workaround at `nuxt.config.ts:230-233`.
  The module resolves the pair itself.
- **Every consumer**: a production build with binding types enabled now fails when the type
  template did not regenerate. Run `nuxt prepare` before the build, or set `bindingTypes: false`.
  `configureNitroCloudflare` takes a context object (`{ rootDir, serverSourceMaps }`) instead of
  a boolean third argument. This is an internal export with no known caller.

New API: `useCloudflareRuntimeConfig(event?)` reads runtime config with or without an event.
Use it to replace any hand-written eventless config helper.

Note: an authored `cache` value still loses to the `workersCache` module option, because that
option also decides whether the caching plugin is registered.

## @harlan-zw/nuxt-cf-jobs

Only nuxtseo.com and gscdump.com use this package.

- **Everyone**: `JobDefinition.maxAttempts`, `LazyJobEntry.maxAttempts` and
  `JobStaticDefinition.maxAttempts` are removed. Rename to `tries`. The build names each file it
  finds, and a missed one warns at boot with `removed-max-attempts` and runs on the default cap
  of 3. The `max_attempts` D1 column and `DurableJobRecord.maxAttempts` are unchanged.
  `inlineRegistryTemplateInNitroDev` is now `inlineTemplateInNitroDev` in
  `src/build/nitro-dev.ts`. `JobStaticMeta.maxAttempts` is replaced by `JobStaticMeta.unreadable`.
  `RegistryBuildPlan` gained `warnings`, and entries gained `loadPath`.
- **nuxtseo.com (apps/pro)**: delete the `orphanedSeconds` and `staleSeconds` overrides and the
  two constants in `layers/saas/shared/cf-jobs-policy.ts`. The defaults are now 900s and 6h,
  which is what those constants held. `reclaimAfterSeconds` derives from `reconcile.staleSeconds`.
  Delete the `process.argv.includes('build') || process.env.CI` gate around
  `terminalFailureContext` and set it unconditionally. Replace the 11 hand-listed `jobsDir` paths
  with `jobsDir: true`. Delete the in-process bypass in
  `layers/pro/sprint/server/tasks/assess-site-now.ts` and enqueue `pro:assess-site` normally.
- **gscdump.com**: delete the `reconcile.orphanedSeconds` and `staleSeconds` overrides unless a
  value other than the new defaults is wanted. Either keep `reclaimAfterSeconds` on
  `createDurableRuntime`, which still wins, or drop it and let `reconcile.staleSeconds` drive both.

No D1 migration is needed. Rows with a null `last_dispatched_at` get one bounded catch-up
re-dispatch on the first sweep after the upgrade.

## @harlan-zw/nuxt-wide-events

- **All consumers**: every record gains `kind`. Widen any strict record schema or D1 column set.
  If you set `drain: true` and still want stdout, set `console: true`; console now defaults to
  off whenever a drain is configured. An `exclude` pattern ending in `/**` now also excludes the
  bare prefix, which affects mdream.dev and request-indexing.
- **unhead.unjs.io**: delete the second standalone event created only to reach
  `setLevel('error')`, and call `setWideEventLevel(event, 'error')` on the request event instead,
  in `layers/tools/server/api/tools/track.post.ts`, `server/utils/upstream-cache.ts` and
  `server/cloudflare-pages-worker.ts`. The four `/standalone` imports now pick up
  `service: 'unhead.unjs.io'` and the configured output with no code change. Type renames:
  `StandaloneWideEventRecord` to `BackgroundWideEventRecord`, `StandaloneWideEvent` to
  `BackgroundWideEvent`, `DrainedStandaloneWideEvent` to `DrainedBackgroundWideEvent`,
  `StandaloneWideEventLevel` to `WideEventLevel`.
- **nuxtseo.com (site and pro)**: replace the background-record sniff at
  `layers/core/shared/logging/wide-event.ts:17` with `record.kind === 'background'`. In
  `layers/saas/server/plugins/wide-event-d1.ts`, store null for `method` and `status` on a
  background record. Both sites set `drain: true`, so set `console: true` to keep stdout.
- **mdream.dev**: `rates: { info: 10 }` no longer drops handled errors, because those records are
  now `level: 'error'`. Expect more error records.
- **gscdump.com**: no action. `enabled: false` no longer breaks the 252 `addWideEventFields`
  call sites.

## @harlan-zw/nuxt-use-query

More code is scanned than before, so expect a longer violation list on the first build.

- `DuplicateFetchTelemetryEvent.url` is replaced by `path` plus `variants`. gscdump.com and
  nuxtseo.com both consume this hook.
- `isFetchWaterfall` takes `(summary, analysis, options)`. Call `analyseFetchChain(summary.timeline)`
  first. nuxtseo.com should delete its 216-line reimplementation in
  `layers/core/server/utils/fetch-telemetry.ts` and use the shipped detection.
- `FetchTelemetryState.duplicateFetchCounts` is replaced by `duplicateFetchGroups`.
- `NuxtRpcError` is a real `Error`. `error.cause` and `error.response` are dropped when the
  failure crosses the SSR payload; the tag, message, status, data and issues survive. nuxtseo.com
  must delete the Sentry rewrap that assumed a plain object, and can delete the
  `watch(query.error)` dedupe now that `useNuxtRpcQuery` takes `onError`.
- `createSourceAstAnalyzer` returns `(ast, context)`, and `RuleContext` gained `isServerFile`.
- `refetchOnMount` no longer runs during server rendering. gscdump.com can drop the
  `refetchOnMount: import.meta.client` pins in its four composables.
- Enforcement now scans layered directories, `ignore` patterns match anywhere in the path, and
  all `server/` code is exempt from `api-literal-outside-query`. nuxtseo.com can delete the
  `ignore` entries that never matched and revisit `severity: 'warn'`. gscdump.com can widen the
  `apiPrefixes` it narrowed to escape the false positives.
- A `slowFetchThreshold` at or above `timeout` now warns at build. nuxtseo.com carries exactly
  that combination.

## @harlan-zw/comark-content

- **harlanzw.com**: `PageCollectionItemBase` no longer declares `newsletter`, `wide`, `h1` or
  `status`. Augment it in a local `.d.ts` to keep them typed. Remove `highlight: true`, now the
  default.
- **unlighthouse.dev**: delete `shared/rangi.ts` and import `contentRangiTheme` and
  `contentRangiLanguages` from the package. Remove `highlight: true`.
- **nuxtseo.com**: delete the stale `layers/site/_root/content.config.ts`, or rename its 17
  collections; the build now fails on duplicate names. Delete
  `layers/design-system/shared/rangi.ts` and import the theme. Replace
  `sitemap: z.literal(false).default(false)` on the snippets schema with `sitemap: false` on the
  collection. Remove `highlight: true`.
- **gscdump.com**: remove the GSCDUMP-43 workaround at
  `server/utils/sentry-event-policy.ts:20-34`. The content revision no longer includes `buildId`,
  so a deploy stops 404ing in-flight clients. Remove `highlight: true`.
- **request-indexing**: remove `highlight: true`.
- **Any consumer of `@harlan-zw/comark-content/server`**: `loadCollectionNames` is now
  `loadCollectionManifest` and returns `Array<{ name, sitemap }>`.

Also exported now, so consumers can drop their copies: `contentRangiTheme`,
`contentRangiLanguages`, `nodeToText`, `walkNodes`.

## @harlan-zw/nuxt-github-sponsors

Three breaking changes: the `tiers` default keys, the `mode` default, and the response union.
All six consumers override `tiers` and five override `mode`, so the defaults affect nobody today.

- **All six**: handle `reason: 'upstream-error'` wherever the response is switched on. An
  upstream failure is now a typed state instead of a 502, so a prerender with `failOnError` no
  longer fails the build.
- **harlanzw.com**: `SponsorList.vue` reads `tiers.top`, which now typechecks against the config.
  Add the `Kintell-labs` override or drop it; the warning names it.
- **mdream.dev**, **unlighthouse.dev**, **nuxtseo.com**: replace the token alias in the deploy
  workflow with `tokenEnv` in `nuxt.config.ts`.
- **unhead.unjs.io**: replace the token alias with `tokenEnv`. Delete the `server: false` plus
  `onMounted` gate at `app/pages/index.vue:62-68` and set `mode: 'client'`.
- **scripts.nuxt.com**: remove `process.env.NUXT_GITHUB_AUTH_TOKEN` from `nuxt.config.ts:31` and
  set `tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN'`.
- **nuxtseo.com**: delete the prerender gate at `apps/site/nuxt.config.ts:437`. It reads
  `NUXT_GITHUB_ACCESS_TOKEN` while the token is `NUXT_GITHUB_SPONSORS_TOKEN`, which is why a
  `not-configured` payload was baked into the deploy. The module now refuses the prerender itself
  when no token exists at build time.

## @harlan-zw/nuxt-domain-events

No breaking change. Consumer notes only.

- **nuxtseo.com**: the absolute `resolve(repoRoot, …)` observer path at
  `layers/saas/nuxt.config.ts:83-84` can become layer-relative. Replace the collect-and-drain
  loops at `layers/pro/sites/server/api/pro/groups.post.ts:37-55` and
  `layers/saas/server/utils/auth/audit.ts:187-207`, and the raw `waitUntil` call sites, with
  `dispatchEventAndDrain`. The custom lint rule policing that pattern can go.
- **gscdump.com**: sets no observer, so the build now warns. Set `domainEvents.observer`, or
  accept stderr-only failure reporting.
- **request-indexing**: `queues: []` now derives from `cfJobs.queues` instead of disabling
  derivation, so a queued listener will build.

## @harlan-zw/nuxt-dx

- The budget action's default `artifact-name` moves to `nuxt-dx-size-budget-v3`. Any consumer
  that does not pin it reports "no baseline" on the first run, passes, then repopulates.
- **gscdump.com**: remove the hand-written `artifact-name: nuxt-dx-size-budget-v3`, now the
  default.
- Any app pinning `artifact-name: nuxt-dx-size-budget-v2` should drop the pin, or a v2-named
  artifact will hold v3 reports.
- The report heading changes from `### Bundle size budget` to `### 📦 Runtime size budget`, and
  the report itself is rebuilt around one verdict line with the tables folded behind
  `<details>`. Any consumer grepping a step summary for the old heading must update. No
  consumer is known to do this.
- **Ten of twelve apps**: delete `sizeBudget.overridesKb: { 'server/plugins/sentry.ts': 326 }`.
  The module recognises the Sentry Nitro plugin and grants it 400 kB on the `nitro` scope. An
  override key that matches no measured entry now warns, so a stale key is visible.
- The budget workflow needs `pull-requests: write` to post its comment. Without it, the diff
  stays in the step summary only.
