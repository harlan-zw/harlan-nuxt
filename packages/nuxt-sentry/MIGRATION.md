# Migrating a site to `@harlan-zw/nuxt-sentry`

One section per site. Line counts are measured, not estimated. "Delete" means the whole file goes.

Every site does the same three things first.

1. `pnpm add @harlan-zw/nuxt-sentry`.
2. Add `'@harlan-zw/nuxt-sentry'` to `modules`, after `'@sentry/nuxt/module'`.
3. Delete the `sentry` build option block, the `sourcemap` block and the `runtimeConfig.sentry` block from `nuxt.config.ts`. The module writes all three.

## Deploy workflow fix, four sites

`zhead.dev`, `mdream.dev`, `unlighthouse.dev` and `request-indexing` deploy on a `workflow_run` event and read the ambient `GITHUB_SHA`. On that event `GITHUB_SHA` is the default branch tip, not the commit that was built, so the release names code that was never deployed.

The build still reports, because a release identity is present. It is simply the wrong one. Add this to the build step of `.github/workflows/deploy-cloudflare.yml`, copying `unhead.unjs.io/.github/workflows/deploy-cloudflare.yml:75-78`:

```yaml
- run: pnpm build
  env:
    # `GITHUB_SHA` is the default branch tip on a `workflow_run` event, so
    # the release tag named a commit this build does not contain. Sentry
    # then blamed live errors on code that was never deployed.
    SENTRY_RELEASE: ${{ github.event.workflow_run.head_sha || github.sha }}
```

`harlanzw.com`, `gscdump.com` and `nuxtseo.com` deploy from a plain `push` job, so their ambient `GITHUB_SHA` is already correct. `unhead.unjs.io` already has the fix. `scripts.nuxt.com` builds on Vercel, and the module reads `VERCEL_GIT_COMMIT_SHA`.

## zhead.dev

Delete: `sentry.client.config.ts` (16), `server/plugins/sentry.ts` (16), `shared/sentry.ts` (19).
Edit `nuxt.config.ts`: remove lines 3, 6-7, 12-17, 35-41 and 145-166.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: 'https://110494db6f0342ee0da4882bd2bfa8e4@o4510507748163584.ingest.us.sentry.io/4511887363014656',
    project: 'zhead',
  },
})
```

Removed: 51 file lines plus about 44 config lines. **95 lines, 3 files.**

## unhead.unjs.io

Delete: `sentry.client.config.ts` (16), `server/plugins/sentry.ts` (16), `shared/sentry.ts` (54), `tests/sentry-target.test.ts` (58). The gate moves into the module and is tested there.
Edit `nuxt.config.ts`: remove lines 4, 6-9, 153-158 and 426-451.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: 'https://f3ae6ad9827cb10d4527a1a47d3fc4de@o4510507748163584.ingest.us.sentry.io/4511887362686976',
    project: 'unhead',
  },
})
```

Keep: the `SENTRY_RELEASE` line in `.github/workflows/deploy-cloudflare.yml:78`.

Removed: 144 file lines plus about 37 config lines. **181 lines, 4 files.**

## mdream.dev

Delete: `sentry.client.config.ts` (16), `server/plugins/sentry.ts` (17).
Shrink `shared/sentry.ts` to the site rules only, about 18 lines. Keep `test/sentry-reporting.test.ts` for them.
Edit `nuxt.config.ts`: remove lines 5, 7-8, 193-199 and 348-369.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: SENTRY_DSN,
    project: 'mdream',
    policy: { ignoreErrors: [EXPECTED_UPSTREAM_ERROR_RE, 'Not supported in zeroRuntime mode.'] },
  },
})
```

Removed: 33 file lines, 20 lines from `shared/sentry.ts`, about 33 config lines. **86 lines, 2 files.**

## harlanzw.com

Delete: `sentry.client.config.ts` (17), `server/plugins/sentry.ts` (16), `shared/sentry.ts` (53), `test/unit/sentry.test.ts` (56).
`isLocalPreviewHost` becomes the module's browser gate. The 404 Drop Rule becomes `policy.dropClientStatus` and now also applies on the server, which fixes the oversight.
Edit `nuxt.config.ts`: remove lines 3, 6-7, 22-26, 59-65 and 293-314.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: 'https://8b3cdae1f3b66b32c99644bdc5da7529@o4510507748163584.ingest.us.sentry.io/4511887363211264',
    project: 'harlanzw-com',
  },
})
```

Removed: 142 file lines plus about 42 config lines. **184 lines, 4 files.**

## scripts.nuxt.com

Delete: `sentry.client.config.ts` (16), `shared/sentry.ts` (27), `test/unit/sentry.test.ts` (13).
Keep `sentry.server.config.ts` (13) and rebuild its `beforeSend` from the shared policy. This is the only non Cloudflare site, so the module registers no server plugin for it.
Edit `nuxt.config.ts`: remove lines 7, 14-15 and 407-429. Keep `autoInjectServerSentry: 'top-level-import'` on the root `sentry` key.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: 'https://7d71e39eb88d57b207e13bd4c05df8cf@o4510507748163584.ingest.us.sentry.io/4511887362818048',
    project: 'nuxt-scripts',
    environment: { 'preview.': 'preview' },
    policy: { dropServerStatus: [[400, 499]] },
  },
})
```

Removed: 56 file lines plus about 26 config lines. **82 lines, 3 files.**

## unlighthouse.dev

Delete: `sentry.client.config.ts` (18), `server/plugins/sentry.ts` (17), `tests/sentry-redaction.test.ts` (40), `tests/sentry-config.test.ts` (53).
Shrink `shared/sentry.ts` to the `EXPECTED_UPSTREAM_FAILURE` marker and its predicate, about 40 lines. Trim `tests/sentry-filter.test.ts` to that half.
The redaction becomes `dataCollection: 'scrubbed'`. The `iabjs://` deny entry is now a module default. The stackless manifest filter is covered by the built in stale chunk rules.
Edit `nuxt.config.ts`: remove lines 7, 9-10, 159-164 and 506-527.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: SENTRY_DSN,
    project: 'unlighthouse',
  },
})
```

Removed: 128 file lines, 126 lines from `shared/sentry.ts`, about 33 config lines. **287 lines, 4 files.**

## request-indexing

Delete: `sentry.client.config.ts` (25), `server/plugins/sentry.ts` (18).
Shrink `shared/sentry.ts` to `errorStatusCode` if other code uses it, otherwise delete it. `resolveSentryInitialization` becomes `gate: 'release'`. `dropExpectedNotFound` becomes the client default. Trim `tests/sentry.test.ts`.
Edit `nuxt.config.ts`: remove lines 9, 12-14, 43-49, 371-377 and 388-409. Also remove lines 72-85, which strip the Sentry rollup and vite plugins by hand.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: SENTRY_DSN,
    project: 'request-indexing',
  },
})
```

401 and 403 now drop on the client by default, which is the dominant noise class for a signed in app.

Removed: 43 file lines, up to 89 lines from `shared/sentry.ts`, about 43 config lines. **up to 175 lines, 2 to 3 files.**

## gscdump.com

Delete: `sentry.client.config.ts` (56), `server/utils/sentry-event-policy.ts` (34), `server/utils/sentry-attribution.ts` (35), `test/sentry-attribution.test.ts` (43). The BigInt scrub is now part of `redactValue`, and the Worker attribution is a module option.
Shrink `server/plugins/sentry.ts` from 52 lines to zero.
Keep: `server/utils/expected-error.ts` (88), which encodes D1, R2, KV and iron rules no other site has; `server/internal/sentry-queue.ts` (71); `server/utils/sentry-job-sink.ts` (69); `server/utils/sentry-protocol-sink.ts` (48); both `sentry-use-query` bridges; `app/utils/sentry-query-policy.ts` (22).
Edit `nuxt.config.ts`: remove lines 52-63, 1085-1113 and most of 1178-1198.

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    dsn: 'https://5a73fdc73e42eb95936085b70f7ebd12@o4510507748163584.ingest.us.sentry.io/4511584664354816',
    project: 'gscdump',
    app: 'gscdump',
    environment: { 'staging.': 'staging' },
    tracesSampleRate: { production: 0.1, staging: 1 },
    dataCollection: 'scrubbed',
    logs: true,
  },
})
```

**This site currently sends unredacted PII on three clients.** `dataCollection: 'scrubbed'` is what fixes it. Pass the same `beforeSend` into `runWithQueueSentry`, so the queue client redacts too:

```ts
import { createBeforeSend } from '@harlan-zw/nuxt-sentry/server'

const { nuxtSentry } = useRuntimeConfig().public
runWithQueueSentry({ queue, context, options: { ...base, beforeSend: createBeforeSend(nuxtSentry.server) } }, run)
```

Removed: 168 file lines across 4 files, plus 52 plugin lines and about 50 config lines. **about 270 lines.**

## nuxtseo.com

Delete: `apps/site/sentry.client.config.ts` (42), `apps/pro/sentry.client.config.ts` (47), `layers/core/shared/logging/sentry-environment.ts` (55), `layers/site-shell/app/utils/client-error-policy.ts` (75), `layers/core/server/plugins/sentry.ts` (37).
Keep `layers/core/shared/logging/redact.ts`, because the D1 logging chokepoint uses it. Only the Sentry half moves.
Keep: `layers/saas/server/utils/sentry-cron.ts`, `sentry-queue.ts`, `sentry-job-sink.ts`, `layers/core/app/plugins/sentry-rpc.client.ts`, both `sentry-use-query` bridges.
`layers/core/server/plugins/wide-event-sentry.ts` (11) becomes `wideEvents: true`.
`layers/core/shared/logging/expected-server-error.ts` (27) can go, or stay as `policy.dropServerStatus: [[400, 499]]`.

```ts
export default defineNuxtConfig({
  // layers/core/nuxt.config.ts
  nuxtSentry: {
    gate: 'ci',
    dataCollection: 'scrubbed',
    environment: { 'staging.': 'staging' },
    tracesSampleRate: { production: 0.05, staging: 1 },
    logs: true,
    wideEvents: true,
    policy: { denyUrls: [/carbon\.js/, /carbonads\.(?:com|net)/] },
  },
  // apps/site/nuxt.config.ts
  nuxtSentry: { app: 'site', project: 'nuxtseo-site', dsn: '...' },
  // apps/pro/nuxt.config.ts
  nuxtSentry: {
    app: 'pro',
    project: 'nuxtseo-pro',
    dsn: '...',
    tracesSampleRate: { production: 0.1, staging: 1 },
    policy: { dropClientStatus: [401, 403, 404, 429, 503] },
  },
})
```

**The server now receives a release**, which fixes gap 9: uploaded client maps bound to an unnamed release.

Removed: 256 file lines across 5 files, plus about 60 config lines. **about 316 lines.**

## Cost summary

| Repo | Files deleted | Lines removed |
| --- | --- | --- |
| `scripts.nuxt.com` | 3 | ~82 |
| `mdream.dev` | 2 | ~86 |
| `zhead.dev` | 3 | ~95 |
| `request-indexing` | 2 to 3 | ~175 |
| `unhead.unjs.io` | 4 | ~181 |
| `harlanzw.com` | 4 | ~184 |
| `gscdump.com` | 4 | ~270 |
| `unlighthouse.dev` | 4 | ~287 |
| `nuxtseo.com` | 5 | ~316 |
| **Total** | **31 to 32** | **~1,676** |
