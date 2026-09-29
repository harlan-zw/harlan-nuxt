# Nuxt DX

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

> Find client errors and oversized runtime entries in your Nuxt app during development and CI.

## Why Nuxt DX?

Some Nuxt problems stay quiet until you go and hunt for them. You may see:

- 🙈 **Errors lost in the console**: Vue warnings and unhandled rejections scroll past in the browser console, and nobody reads them.
- 💧 **Opaque hydration mismatches**: Vue reports each mismatch as one flat message, so you guess which component and which value broke.
- 📦 **Silent bundle growth**: A plugin or middleware pulls in a heavy dependency, and nothing tells you.

Nuxt DX shows client errors during development and in your terminal. It warns when a runtime entry makes your JavaScript bundles too big.

## Features

- 🚨 **Client error overlay**: Vue warnings, console errors, and unhandled rejections no longer scroll past unseen in the browser console.
- 💧 **Hydration mismatches, decoded**: You stop guessing which component and which value broke hydration.
- 🤖 **Agent handoff**: You stop copying errors, routes, and file paths into a coding agent by hand.
- 🔍 **[Inspect a route](#inspect-a-route)**: You get a route's client errors in your terminal or CI without opening a browser yourself.
- 🧺 **[Payload Diagnostics](#payload-diagnostics)**: You find payload fields that ship to the client but never get read.
- 📦 **Runtime size budgets**: A plugin or middleware that pulls in a heavy dependency no longer grows your bundle unnoticed.
- 📈 **Regression diffs**: A pull request that takes a plugin from 12 kB to 48 kB gets flagged before it merges.

## Installation

```bash
pnpm add -D @harlan-zw/nuxt-dx
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-dx
> ```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-dx'],
})
```

## Inspect a route

While Nuxt dev runs, run this from your app directory:

```sh
pnpm exec nuxt-dx install-browser # once, to install Chromium
pnpm exec nuxt-dx inspect
```

The command finds the running server and inspects the home page.
Pass a path to inspect another route:

```sh
pnpm exec nuxt-dx inspect /about
```

The report combines client errors, console warnings, hydration mismatches, and payload diagnostics from the initial page load.
It also includes diagnostics that modules send to the dev overlay.
It does not click through interactions. It does not include server logs or size budgets.

The inspection browser disables Nuxt DevTools because its payload reads can hide unread fields.
Normal browser sessions keep DevTools enabled.

The terminal shows a readable report. For scripts, use `--json`. To save the JSON to a file, use `--output report.json`.
Exit code `1` means the page reported errors or the command could not run.
Exit code `2` means the observation was incomplete and recorded no errors.
Warnings alone leave the exit code at `0`.

If your app lives in another directory, pass `--cwd apps/web`.
For a preview server or remote site, pass a full URL:

```sh
pnpm exec nuxt-dx inspect http://localhost:3000/about
```

Prerendered pages need the [payload option below](#prerendered-pages) to report hydration completion and unread fields.
Vue source context comes from the dev overlay. Production builds do not have it.

## Error overlay

The overlay collects Vue warnings, Vue errors, console errors, uncaught errors, and unhandled rejections. It can copy a short report with the route and source files, ready for a coding agent.

The overlay does nothing in production. Nuxt DX registers its client plugin only in development mode.

```ts
export default defineNuxtConfig({
  nuxtDx: {
    position: 'bottom-right',
  },
})
```

Other modules can send errors and warnings to the same overlay through the typed `nuxt-dx:issue` runtime hook. The DX plugin runs first, so a module plugin can report a diagnostic during setup and not lose it.

```ts
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('nuxt-use-query:telemetry:query:finish', (event) => {
    if (event.status === 'error') {
      return nuxtApp.callHook('nuxt-dx:issue', {
        kind: 'error',
        message: `Query failed: ${event.request}`,
      })
    }
  })
})
```

## Hydration mismatches

Hydration mismatches get their own count on the badge and their own section in the report. Vue passes each mismatch to `warnHandler` as one flat message. The overlay parses that message, then adds the component that was hydrating and its source file.

The badge reads `1 err | 1 warn | 5 hydration`, and the panel lists each mismatch as:

```
HYDRATION Class mismatch in <RandomBadge>
  file: app/components/RandomBadge.vue
  on: HTMLSpanElement
  server: class="warm"
  client: class="cool"
```

The copied report has one heading per mismatch:

```md
### 2. Class mismatch in <RandomBadge>
- Component file: `app/components/RandomBadge.vue`
- Component chain: RandomBadge < Index < RouteProvider < RouterView < NuxtPage
- DOM node: `HTMLSpanElement`
- Server rendered: `class="warm"`
- Client rendered: `class="cool"`
```

The overlay recognises node, text, children, class, style, and attribute mismatches. It drops Vue's follow-up `Hydration completed but contains mismatches.` console error, because the list already shows each mismatch. Two reports of the same mismatch become one entry. The overlay keys a mismatch by its location and ignores the printed values. So a clock that renders `Date.now()` does not add an entry each time it drifts.

## Payload Diagnostics

A page can fetch a whole product and only render its title.
Payload diagnostics show which top-level fields the client did not read during initial hydration.

Tracking runs by default in development. To disable it:

```ts
export default defineNuxtConfig({
  nuxtDx: {
    payloadUsage: false,
  },
})
```

If tracking is on, reload the page. The overlay lists unread fields from plain `payload.data[key]` objects, with estimated JSON sizes.
Tracking starts after Nuxt restores the payload, before ordinary app plugins run.
It stops when initial hydration finishes.

If the page reads `product.title`, the report can flag `product.details`.
If nothing needs `details`, omit it from the fetch result.
If a later interaction needs it, consider fetching it when that interaction happens.
Nuxt DX does not change the data.

### Reading the results

Only top-level fields count. Reading `product.author.name` counts as reading the whole `author` field.
The report does not cover later navigation, delayed hydration, `useState`, or Pinia.
Framework reads can also count, so the report may miss fields your components never use.

Unread fields may still serve lazy components or later interactions. Check those uses before removing data.
Byte estimates describe each field as a standalone JSON object. Do not add them together or treat them as compressed savings.
Tracking adds overhead. Measure load time with tracking disabled after making your changes.

### Prerendered pages

Prerendering alone cannot tell you what the browser reads. Run each generated route through Chromium to collect a report.

For the diagnostic build, enable browser collection:

```ts
export default defineNuxtConfig({
  nuxtDx: {
    payloadUsage: { prerender: true },
  },
})
```

Generate the site, install Chromium once, and start the preview server:

```sh
pnpm exec nuxt generate
pnpm exec nuxt-dx install-browser
pnpm exec nuxt preview --port 3000
```

In another terminal, check each route you want to inspect:

```sh
pnpm exec nuxt-dx inspect http://localhost:3000/ --output home.json
pnpm exec nuxt-dx inspect http://localhost:3000/about --output about.json
```

Each command opens a fresh browser and waits for initial hydration.
The JSON contains read fields, unread fields, and reasons for skipped entries. It excludes payload values.
The report includes browser and HTTP errors. Missing instrumentation marks the report as incomplete.
If hydration needs more than 30 seconds, add `--timeout 60000`.

The command enables collection before app startup and leaves the route URL unchanged.
Normal production visits do not collect a report.
Remove the `prerender` option before your deployment build to leave out the tracking code.

<details>
<summary>Skipped data and scan limits</summary>

Tracking wraps payload objects in proxies. If earlier code holds references outside `payload.data`, set `payloadUsage: false`.
Tracking cannot see those earlier references. Their identity also differs from the proxy.

- Tracking skips arrays, primitives, reactive objects, refs, frozen objects, getters, and readonly or nonconfigurable properties.
- Payload cache entries must be writable. Nested references, including Map and Set entries, can cause an object to be skipped.
- If the reference scan cannot finish, all entries are skipped.
  Custom objects, functions, accessors, and hidden Vue proxy references can stop the scan.
  The scan also stops after 10,000 objects, properties, or collection entries.
- Enumeration, membership checks, writes, and framework reads count as use. They can hide unread fields.
- Tracking ignores nested fields and custom root payload entries.
- Cyclic, shared, or non-JSON field values have no size estimate.
  Estimates stop at 64 levels, 10,000 traversal steps, or a conservative 1 MiB JSON output bound.

</details>

## Runtime size budgets

Runtime budgets cover four entry kinds. Nuxt plugins and route middleware apply to the client bundle. Nitro plugins and middleware apply to the server bundle. Entries registered by your app and installed Nuxt modules use the same budgets.

Each entry is charged its post-tree-shaking size plus every JavaScript module reachable only through it. Entries in one bundle share a single attribution pass. If two entries import a dependency, neither receives that shared cost.

```
[nuxt-dx]  WARN  1 Nuxt plugin over budget in the client bundle

  analytics  app/plugins/heavy.client.ts
  31.5 kB bundled, 21.5 kB over the 10 kB budget
    ├─  310 B  the plugin file
    ├─ 3.9 kB  app/lib/part1.ts
    ├─ 3.9 kB  app/lib/part2.ts
    ├─ 3.9 kB  app/lib/part3.ts
    └─19.5 kB  across 5 more modules

  Defer heavy imports with `await import()`, or allow the size:
    nuxtDx.sizeBudget.overridesKb = { 'analytics': 32 }
```

The warning lists the three heaviest modules and folds the rest into one line. The breakdown always adds up to the reported total. The suggested override rounds up past the current size. Every entry over budget goes into one snippet you can copy.

If a plugin declares a name, the warning uses that name. The file path stays beside it, so you can still click through:

```ts
export default defineNuxtPlugin({
  name: 'analytics',
  setup() {},
})
```

Nuxt DX reads both `defineNuxtPlugin({ name })` and `defineNuxtPlugin(fn, { name })`. Other entries use their path. If a Nuxt module registered an entry, warnings and reports name that module as its owner. The owner is metadata only. It never charges the entry twice.

## The size budget report

Reporting is off by default. If you set `report: true`, every build writes `.nuxt/dx/size-budget.json`. The report has one entry per measured runtime entry.

```ts
export default defineNuxtConfig({
  nuxtDx: {
    // or `{ path: 'ci/size-budget.json' }` to write it somewhere else
    report: true,
  },
})
```

```json
{
  "version": 3,
  "entries": [
    {
      "scope": "client",
      "path": "app/plugins/analytics.client.ts",
      "ownBytes": 182,
      "exclusiveBytes": 7626,
      "totalBytes": 7808
    },
    {
      "scope": "client-middleware",
      "owner": "fixture-auth-module",
      "path": "node_modules/fixture-auth-module/runtime/auth.global.ts",
      "ownBytes": 834,
      "exclusiveBytes": 12000,
      "totalBytes": 12834
    },
    {
      "scope": "nitro",
      "path": "server/plugins/audit.ts",
      "ownBytes": 117,
      "exclusiveBytes": 6423,
      "totalBytes": 6540
    }
  ]
}
```

`scope` is `client`, `client-middleware`, `nitro`, or `nitro-middleware`. Paths are relative to the app root. `owner` names the Nuxt module that registered an entry when Nuxt exposes that relationship.

Reports leave out disabled entry kinds. The client bundle needs `nuxi build`. Development runs report only Nitro entries.

## Catching regressions

An absolute budget catches a bundle that is already too big. It says nothing about the pull request that takes a healthy 12 kB plugin to 48 kB. `nuxt-dx compare` reads the report from two builds and fails when anything grew past a threshold:

```bash
nuxt-dx compare base/.nuxt/dx/size-budget.json .nuxt/dx/size-budget.json
```

```md
### 📦 Runtime size budget

⚠️ **1 target past the 10 kB threshold** · net +27.2 kB · 🆕 1 new target

| Target | Scope | Size | Δ |
| --- | --- | --- | --- |
| `app/plugins/analytics.client.ts` | Nuxt plugin | 7.6 kB → 43.3 kB | 🔴 +35.6 kB (+467.9%) |
| `runtime/consent.client.ts`<br><sub>fixture-consent</sub> | Nuxt plugin | 0 B → 170 B | 🆕 new |
| `app/middleware/legacy.global.ts` | Nuxt middleware | 12.5 kB → 3.9 kB | 🟢 -8.6 kB (-68.8%) |

<details><summary>Bundle totals</summary>

| Bundle | Size | Δ |
| --- | --- | --- |
| **Client** | 23.1 kB → 50.4 kB | +27.2 kB |
| <sub>Nuxt plugins</sub> | <sub>10.6 kB → 46.5 kB</sub> | <sub>+35.8 kB</sub> |
| <sub>Nuxt middleware</sub> | <sub>12.5 kB → 3.9 kB</sub> | <sub>-8.6 kB</sub> |
| **Server** | 6.4 kB → 6.4 kB | +0 B |
| <sub>Nitro plugins</sub> | <sub>6.4 kB → 6.4 kB</sub> | <sub>+0 B</sub> |
</details>

<details><summary>2 unchanged targets</summary>

| Target | Scope | Size | Δ |
| --- | --- | --- | --- |
| `app/plugins/theme.client.ts` | Nuxt plugin | 3 kB → 3 kB | — |
| `server/plugins/audit.ts` | Nitro plugin | 6.4 kB → 6.4 kB | — |
</details>

<sub>Each target is charged its own bundled bytes plus every module it alone pulls in. The threshold applies to each target on its own, not to the total.</sub>
```

Markdown goes to stdout for job summaries. The local verdict goes to stderr. Client and server totals combine their disjoint runtime entries.

`--threshold-kb` sets how much one target may grow before the command fails. The default is 10 kB. The threshold applies to each target. The bundle totals show drift that adds up across targets.

If there is no baseline, `--allow-missing-base` says so and passes. Exit code `1` means a target grew past the threshold. Exit code `2` means a report could not be read. Exit code `0` means no target grew past the threshold.

## GitHub Actions

The comparison runs after your build step, in the job you already have. Your build already wrote the report, so nothing builds twice.

First, turn the report on:

```ts
export default defineNuxtConfig({
  nuxtDx: {
    report: true,
  },
})
```

Then add the action to the workflow that builds your app:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  # the action lists artifacts and downloads a compatible baseline
  actions: read
  # the action posts the diff as a pull request comment, and replaces its own
  pull-requests: write

jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.0.0
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.2.0
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.0.0
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      - uses: harlan-zw/harlan-nuxt/.github/actions/nuxt-dx-budget@main
        with:
          report-path: .nuxt/dx/size-budget.json
          threshold-kb: 10
```

Use a different `artifact-name` for each app and environment. The action appends the checked-out commit to this prefix.
It searches retained artifacts on the base branch, including reports from other workflows.
It selects an earlier run at the same source commit or an ancestor. Future runs cannot become its baseline.
This also covers content updates that rebuild the same commit.

A first run starts a new baseline and says so in the summary. Older artifacts without source commits are ignored.
API failures and failed downloads fail reporting. Only valid reports are uploaded, including reports that exceed the threshold.

For advisory deploy reporting, run the action after deployment with `continue-on-error: true` and `comment: 'false'`.
To surface a failed action, read its step outcome. To limit runner time, set a step timeout.
The action reads artifacts through GitHub's API. It needs GitHub CLI only when pull request comments are on.

On a pull request, the diff appears twice: in `$GITHUB_STEP_SUMMARY` and in one pull request comment. Each push edits that same comment and adds no new one. To turn the comment off, set `comment: false`.

The comment needs `pull-requests: write`. Without it, or on a pull request from a fork, the comment step logs a notice. The summary still shows the diff.

By default, the step reports growth and lets the job pass. To fail the job when a target grows past the threshold, set `fail-on-breach: true`. The step always fails if it cannot compare the two reports, because then nothing was measured.

| Input | Default | |
| --- | --- | --- |
| `report-path` | `.nuxt/dx/size-budget.json` | Report your build wrote, relative to `working-directory` |
| `threshold-kb` | `10` | Growth allowed for a single target |
| `artifact-name` | `nuxt-dx-size-budget-v3` | Artifact prefix for the app and environment |
| `base-branch` | pull request base, then the default branch | Branch the baseline comes from |
| `working-directory` | `.` | Directory the app was built in |
| `comment` | `true` | Post the diff as a pull request comment, replacing this action's previous one |
| `fail-on-breach` | `false` | Fail the job when a target grew past the threshold |
| `github-token` | `${{ github.token }}` | Needs `actions: read`, plus `pull-requests: write` to comment |

## Configuring budgets

```ts
export default defineNuxtConfig({
  nuxtDx: {
    sizeBudget: {
      // kB budget per Nuxt app plugin in the client bundle, `false` to disable
      pluginsKb: 30,
      // kB budget per Nuxt route middleware in the client bundle
      middlewareKb: 20,
      // kB budget per Nitro plugin in the server bundle, `false` to disable
      nitroPluginsKb: 75,
      // kB budget per Nitro middleware in the server bundle
      nitroMiddlewareKb: 20,
      // keyed by plugin name, Nuxt module name, or any fragment of an entry path
      overridesKb: {
        'analytics': 60,
        'server/plugins/queue': 120,
        'server/middleware/auth': 30,
      },
      // throw instead of warning
      fail: false,
    },
    // write the measurements to JSON for `nuxt-dx compare`, off by default
    report: false,
  },
})
```

Set `sizeBudget: false` to turn the check off entirely.

A key in `overridesKb` must match a plugin name, a Nuxt module name, or a fragment of an entry path. A key that matches nothing changes no budget. So the build warns about each key that matched no runtime entry:

```
[nuxt-dx]  WARN  1 `sizeBudget.overridesKb` key matched no runtime entry: `server/plugins/sentry.ts`.
                 Each key must be a plugin name, a Nuxt module name, or a fragment of an entry path.
```

Some modules ship a runtime entry that no app can make smaller. Those entries carry their own budget, so you do not copy the same override into every app. `@sentry/nuxt` and `@harlan-zw/nuxt-sentry` get 400 kB for their Nitro plugin. A known budget only raises the scope budget. If you set a higher `nitroPluginsKb`, or write your own override, your value wins.

Nuxt DX checks budgets each time a bundle is built. Nitro entries report during development and builds. Client entries report only during builds.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-dx/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-dx/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-dx

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-dx.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-dx

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-dx/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
