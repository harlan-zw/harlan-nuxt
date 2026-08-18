<h1>@harlan-zw/nuxt-sentry</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Sentry owns one Report Policy for a whole estate of sites. It registers the client and server Sentry clients, decides who may report, and applies the same Drop Rules and Redaction Rules on both sides.

It does not wrap the Sentry SDK. Your code keeps importing `@sentry/nuxt` and `@sentry/cloudflare` directly.

Status: experimental. APIs may change before the first release.

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

- 🚦 **One enable gate:** a release identity proves a deploy produced the build, so `wrangler dev` and `nuxt preview` cannot report as production.
- 🧹 **Redaction Rules:** credentials are removed by key name and by value shape, on every report, on both sides.
- 🎯 **Drop Rules:** status codes, transient upstream failures, browser noise, stackless failures, breadcrumb matches and extension frames, decided by one pure function.
- 🏷️ **Release and environment naming:** resolved once at build time, then shared by the client and the server.
- 📦 **Registered from the module:** `@harlan-zw/nuxt-dx` attributes the bundle entry to this package instead of to an anonymous site plugin.
- ☁️ **Cloudflare Worker version tags:** read from the `CF_VERSION_METADATA` binding, so a report names the exact Worker version.

## Installation

```bash
pnpm add @harlan-zw/nuxt-sentry @sentry/nuxt
```

On Cloudflare Workers, also add `@sentry/cloudflare`.

```ts
export default defineNuxtConfig({
  modules: ['@sentry/nuxt/module', '@harlan-zw/nuxt-sentry'],
  nuxtSentry: {
    dsn: 'https://key@o0.ingest.us.sentry.io/0',
    project: 'my-project',
  },
})
```

Set `SENTRY_AUTH_TOKEN` in CI to upload source maps. Set `SENTRY_RELEASE` in the deploy workflow, because the default gate needs it.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Error Report | One captured exception sent to the error tracker. |
| Report Policy | The rules that decide whether an Error Report is sent and what it carries. |
| Drop Rule | One predicate that stops an Error Report before it is sent. |
| Redaction Rule | One transform that removes a secret or personal value from an Error Report. |

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register anything at all. |
| `dsn` | required | The public Sentry DSN. |
| `org` | `'harlan-zw'` | Sentry organisation slug. |
| `project` | none | Sentry project slug. Required when source maps upload. |
| `app` | none | The `app` tag, for one organisation serving several deployments. |
| `gate` | `'release'` | Who may send an Error Report. See Gates. |
| `environment` | `'production'` | Environment name, or a host prefix map. |
| `tracesSampleRate` | `0.05` | Fraction of requests traced, or a rate per environment. |
| `dataCollection` | `'scrubbed'` | How much of the request a report carries. |
| `policy` | see below | Report Policy. |
| `sourceMaps` | `true` | Emit and upload client source maps when a token is present. |
| `logs` | `false` | Forward `console.warn` and `console.error` to Sentry Logs. |
| `workerVersionBinding` | `'CF_VERSION_METADATA'` | Cloudflare binding holding the Worker version. |
| `wideEvents` | `false` | Forward failing Wide Events to Sentry Logs. See Wide Events. |

### Gates

`gate` decides who may send an Error Report.

| Value | Requires |
| --- | --- |
| `'release'` | A production build that carries a release identity. |
| `'ci'` | A production build produced in CI. |
| `'always'` | Any production build. |

The default is `'release'`. A release identity is the proof that a deploy produced the build. `nuxt preview` and `wrangler dev` both run a production build with `NODE_ENV=production`, so `NODE_ENV` alone lets a laptop file issues against the live project. One site measured 232 events from a single local session against 223 real errors org wide in the same day.

The release comes from `SENTRY_RELEASE`, then `GITHUB_SHA`. Set `SENTRY_RELEASE` explicitly in a deploy workflow. On a `workflow_run` event `GITHUB_SHA` is the default branch tip rather than the commit that was built, so the release names code that was never deployed.

```yaml
env:
  SENTRY_RELEASE: ${{ github.event.workflow_run.head_sha || github.sha }}
```

The browser applies one more gate that a build cannot see. A bundle served from a loopback or RFC1918 host is never a deployment, so it reports nothing.

### Data collection

`dataCollection: 'scrubbed'` sends the request, then applies every Redaction Rule. `'none'` sends no personal data at all.

Redaction runs on every report under both settings. `'none'` suppresses the request fields, but an ofetch error message still quotes the failing URL, query string and all, and no data collection setting stops that.

### Report Policy

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    policy: {
      // Server statuses that never report. Default `[404]`.
      dropServerStatus: [404, [500, 599]],
      // Client statuses that never report. Default `[401, 403, 404]`.
      dropClientStatus: [401, 403, 404],
      // Drop TimeoutError, AbortError and the abort messages. Default `true`.
      dropTransient: true,
      // Extra message patterns, on top of the built-in browser noise list.
      ignoreErrors: [/^Failed to fetch https?:\/\/\S+$/],
      // Messages that drop only when the report carries no stack frame.
      dropStacklessErrors: [/^TypeError: Failed to fetch$/],
      // Messages that drop when any breadcrumb matches.
      dropBreadcrumbMessages: [/Failed to fetch dynamically imported module/],
      // Extra source URL patterns, on top of the built-in extension list.
      denyUrls: [/carbonads\.(?:com|net)/],
      // Use the built-in browser noise lists. Default `true`.
      browserNoise: true,
      // Extra key names every Redaction Rule treats as secret.
      secretKeys: ['dataForSeoLogin'],
    },
  },
})
```

The server default is 404 only. 401, 403 and 429 keep reporting, because an auth regression or a rate limit spike must stay visible. The client default adds 401 and 403, where the same status is an expired session racing a redirect to the login page.

`dropStacklessErrors` and `dropBreadcrumbMessages` are both empty by default, so neither changes a site until it asks.

Use `dropStacklessErrors` when the same message is a defect with a stack and noise without one. A browser that rejects a fetch on the global handler produces `TypeError: Failed to fetch` with an empty frame list, and no frame names site code. The same message with a stack still reports.

Use `dropBreadcrumbMessages` when the breadcrumb names the cause and the exception does not. A stale chunk load after a deploy often throws inside a component, so only the console breadcrumb says the chunk was gone.

Every Drop Rule runs in a fixed order and the decision names the rule that fired: `status`, `transient`, `ignore-message`, `stackless-message`, `breadcrumb-message`, `deny-url`.

### Environment and sampling

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    environment: { 'staging.': 'staging' },
    tracesSampleRate: { production: 0.05, staging: 1 },
  },
})
```

The browser resolves the environment from its hostname. The server has no hostname, so it takes `SENTRY_ENVIRONMENT` when set, and `'production'` otherwise.

## What it does not do

- **It does not wrap or re-export the Sentry SDK.** Keep importing `@sentry/nuxt` and `@sentry/cloudflare` for `captureException`, `withScope` and `addBreadcrumb`.
- **It does not replace `@sentry/nuxt/module`.** That module still owns the build plugin, the source map upload and the client entry injection. This module configures it.
- **It does not own the queue Sentry client.** `runWithQueueSentry` lives in `@harlan-zw/nuxt-cf-jobs/sentry`. Build its `beforeSend` from `@harlan-zw/nuxt-sentry/server`.
- **It does not write a Wrangler file.** `@harlan-zw/nuxt-cloudflare` owns that, and `upload_source_maps` with it.
- **It does not capture per request errors twice.** It never hooks the Nitro `error` event itself.
- **It does not add Sentry Cron monitors or RPC capture.** Those cost a billed monitor seat and one site each uses them.
- **It does not redact application log payloads.** Only the Sentry road is covered.

## Non Cloudflare presets

The server plugin is registered only on a Cloudflare Nitro preset, because `@sentry/cloudflare` is the only SDK that runs on Workers and it cannot be bundled into a Node build. On any other preset the module logs a warning and registers no server plugin. Keep the site's own `sentry.server.config.ts` and build its `beforeSend` from the shared policy.

Import the policy from `#nuxt-sentry/policy`, never from runtime config:

```ts
import { createBeforeSend } from '@harlan-zw/nuxt-sentry/server'
import * as Sentry from '@sentry/nuxt'
import { nuxtSentry } from '#nuxt-sentry/policy'

if (nuxtSentry.target._tag === 'enabled') {
  Sentry.init({
    dsn: nuxtSentry.target.dsn,
    beforeSend: createBeforeSend(nuxtSentry.server),
  })
}
```

### Why not runtime config

`#nuxt-sentry/policy` is the resolved Report Policy written as a build time constant. It holds one object literal and imports nothing.

`useRuntimeConfig()` in the same file makes the emitted `sentry.server.config.mjs` import the Nitro chunk. The whole application and `node:http` then evaluate before `Sentry.init` runs, which defeats `autoInjectServerSentry: 'top-level-import'` and loses the instrumentation that setting exists to install. On one Vercel site the emitted file carried 35 imports; reading the constant instead brings it to 3.

The same constant is still written to `runtimeConfig.public.nuxtSentry`, so code that already reads it keeps working.

## Wide Events

With `@harlan-zw/nuxt-wide-events` installed, two bridges are wired and neither package imports the other.

The Sentry trace identity is written into every request's Wide Event as `sentry.traceId` and `sentry.spanId`, so the two sinks can be joined. The fields are declared through the `wide-events:fields` build hook, so the allowlist stays exhaustive.

With `wideEvents: true` and the Wide Events `drain` option on, a failing Wide Event is forwarded to Sentry Logs. A log, never an error: a Wide Event carries no stack in production, and Sentry already captured the same failure from the same request.

`true` forwards a Wide Event whose level is `error`. Nothing else. Widen it only when the extra records are worth their bytes:

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    logs: true,
    wideEvents: { levels: ['warn', 'error'] },
  },
})
```

Sentry meters Logs as their own byte quota, separate from the error quota. Every level added here spends that quota on every matching request, so the default stays at `error`. A level outside `warn` and `error` throws at build time.

## Development

```bash
pnpm install
pnpm dev:prepare
pnpm test
```

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/@harlan-zw/nuxt-sentry/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-sentry

[npm-downloads-src]: https://img.shields.io/npm/dm/@harlan-zw/nuxt-sentry.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-sentry

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
