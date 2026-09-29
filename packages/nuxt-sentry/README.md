# Nuxt Sentry

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

> One Sentry Report Policy for every Nuxt site, on the client and the server.

## Why Nuxt Sentry?

Every Nuxt site that reports to Sentry needs the same setup. Each copy drifts in its own way.

- 💻 **Local builds report as production**: `nuxt preview` and `wrangler dev` run with `NODE_ENV=production`, so your laptop sends Error Reports to the live project.
- 🔑 **Secrets leave in Error Reports**: Tokens, passwords, and query strings ride along in request data and error messages.
- 🔇 **Noise buries real errors**: Browser extension errors, expected status codes, and aborted fetches crowd out the errors you need to fix.
- 🔀 **Client and server disagree**: Each side gets its own drop logic and release name, so one deploy looks like two.

Nuxt Sentry gives every site one Report Policy, with the same Drop Rules and Redaction Rules in the browser and on the server. It does not wrap the Sentry SDK; your code keeps importing `@sentry/nuxt` and `@sentry/cloudflare` directly.

## Features

- 🚦 **One enable gate**: `wrangler dev` and `nuxt preview` builds never report to Sentry as production.
- 🧹 **Redaction Rules**: Tokens and passwords never leave in an Error Report, from the browser or the server.
- 🎯 **Drop Rules**: Browser extension noise, expected status codes, and transient upstream failures stop burying the errors you need to fix.
- 🏷️ **Release and environment naming**: Client and server Error Reports from one deploy always carry the same release and environment.
- 📦 **Registered from the module**: `@harlan-zw/nuxt-dx` bundle reports name this package, so you can see what Sentry costs your bundle.
- ☁️ **Cloudflare Worker version tags**: Each Error Report names the exact Worker version that failed.

## Installation

```bash
pnpm add @harlan-zw/nuxt-sentry @sentry/nuxt
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-sentry
> ```

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
| `tasks` | `true` | Report every Nitro scheduled task's failures, tagged with the task name. |
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

The default is `'release'`. A release identity proves that a deploy produced the build. `nuxt preview` and `wrangler dev` both run a production build with `NODE_ENV=production`. With `NODE_ENV` alone, your laptop sends Error Reports to the live project. On one site, a single local session sent 232 Error Reports. The whole org had 223 real errors that day.

The release comes from `SENTRY_RELEASE`, then `GITHUB_SHA`. Set `SENTRY_RELEASE` in the deploy workflow. On a `workflow_run` event, `GITHUB_SHA` is the default branch tip. That may differ from the commit that was built, so the release can name code that never deployed.

```yaml
env:
  SENTRY_RELEASE: ${{ github.event.workflow_run.head_sha || github.sha }}
```

The browser adds one more gate that a build cannot see. A bundle served from a loopback or RFC1918 host reports nothing, because it is never a deployment.

### Data collection

`dataCollection: 'scrubbed'` sends the request, then applies every Redaction Rule. `'none'` sends no personal data at all.

Every Redaction Rule runs on every Error Report under both settings. `'none'` removes the request fields. An ofetch error message still quotes the failing URL, query string included, and no `dataCollection` value stops that.

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

The server default is 404 only. 401, 403 and 429 keep reporting, so you still see an auth regression or a rate limit spike. The client default adds 401 and 403. In the browser, those statuses usually mean an expired session racing a redirect to the login page.

`dropStacklessErrors` and `dropBreadcrumbMessages` are both empty by default. Neither drops anything until you configure it.

Use `dropStacklessErrors` when the same message is a defect with a stack and noise without one. If a browser rejects a fetch on the global handler, you get `TypeError: Failed to fetch` with no frames. Nothing points at site code. The same message with a stack still reports.

Use `dropBreadcrumbMessages` when the breadcrumb names the cause and the exception does not. A stale chunk load after a deploy often throws inside a component, so only the console breadcrumb says the chunk was gone.

The Drop Rules run in a fixed order, and the decision names the rule that fired: `status`, `transient`, `ignore-message`, `stackless-message`, `breadcrumb-message`, `deny-url`.

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
- **It does not report a request error twice.** It never listens on the Nitro `error` hook.
- **It does not add Sentry Cron monitors or RPC capture.** Cron monitors cost a billed seat each, and only one site uses each feature.
- **It does not redact application log payloads.** Redaction Rules cover only what goes to Sentry.

## Non Cloudflare presets

The module registers the server plugin only on a Cloudflare Nitro preset. `@sentry/cloudflare` is the only SDK that runs on Workers, and a Node build cannot bundle it. On any other preset, the module logs a warning and registers no server plugin. Keep the site's own `sentry.server.config.ts` and build its `beforeSend` from the shared policy.

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

If the same file calls `useRuntimeConfig()`, the emitted `sentry.server.config.mjs` imports the Nitro chunk. The whole application and `node:http` then load before `Sentry.init` runs. That breaks `autoInjectServerSentry: 'top-level-import'`, and you lose the instrumentation it installs. On one Vercel site the emitted file had 35 imports; the constant brought it to 3.

The module also writes the constant to `runtimeConfig.public.nuxtSentry`, so code that reads it there keeps working.

## Scheduled tasks

Nitro's `runTask` calls no hook, so no plugin can see a scheduled task run. A task that throws reaches Sentry, if at all, as a bare `scriptThrewException` with no task name.

On a Cloudflare preset, the module wraps every registered task at build time. That includes tasks another module registers from inside its own package. The wrapper reports a failure with a `task` tag, then rethrows it, so the scheduler still sees the task fail. To leave tasks alone, set `tasks: false`.

`withSentryTask` wraps one task by hand. Use it when `tasks` is off, or in a task file shared with a build the module does not cover. A second wrap has no effect, so one failure reports once.

```ts
import { withSentryTask } from '@harlan-zw/nuxt-sentry/server/task'

export default withSentryTask(defineTask({
  meta: { name: 'my:cron' },
  async run() {
    // ...
  },
}))
```

`withSentryTask` reports through `@sentry/cloudflare`, so it runs on a Cloudflare Workers preset only. It has its own subpath export. That keeps the SDK-free `@harlan-zw/nuxt-sentry/server` barrel working on Node, where the peer is not installed.

## Wide Events

If `@harlan-zw/nuxt-wide-events` is installed, the module connects the two packages in two ways. Neither package imports the other.

The module writes the Sentry trace identity into every request's Wide Event as `sentry.traceId` and `sentry.spanId`. You can then join a Wide Event to its Sentry trace. The module declares these fields through the `wide-events:fields` build hook, so the allowlist stays complete.

With `wideEvents: true` and the Wide Events `drain` option on, the module forwards a failing Wide Event to Sentry Logs. It sends a log, never an Error Report. A Wide Event carries no stack in production, and Sentry already captured the same failure from that request.

`true` forwards only a Wide Event whose level is `error`. Widen it only when the extra records are worth their bytes:

```ts
export default defineNuxtConfig({
  nuxtSentry: {
    logs: true,
    wideEvents: { levels: ['warn', 'error'] },
  },
})
```

Sentry bills Logs against their own byte quota, separate from the error quota. Each level you add spends that quota on every matching request, so the default is `error` only. A level outside `warn` and `error` throws at build time.

## Development

```bash
pnpm install
pnpm dev:prepare
pnpm test
```

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-sentry/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-sentry/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-sentry

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-sentry.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-sentry

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-sentry/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
