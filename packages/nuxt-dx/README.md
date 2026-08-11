<h1>@harlan-zw/nuxt-dx</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt DX is a diagnostics module that surfaces problems you would otherwise have to find yourself: client errors during development, and runtime entries that quietly bloat your JavaScript bundles.

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

- 🚨 **Client error overlay:** Vue warnings, Vue errors, console errors, uncaught errors, and unhandled rejections in one badge, and a strict production no-op.
- 💧 **Hydration mismatches, decoded:** counted separately and read back as component, source file, and the two values that disagreed.
- 🤖 **Agent handoff:** copy a route-scoped report with source files attached, ready to paste at a coding agent.
- 📦 **Runtime size budgets:** warn when a Nuxt plugin, route middleware, Nitro plugin, or Nitro middleware pulls too much JavaScript into its bundle.
- 📈 **Regression diffs:** write a machine-readable report, then compare builds with the CLI or GitHub action before added JavaScript lands.

## Installation

```bash
pnpm add -D @harlan-zw/nuxt-dx
```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-dx'],
})
```

## Error overlay

A client error overlay that collects Vue warnings, Vue errors, console errors, uncaught errors, and unhandled rejections. It can copy a concise report with route and source-file context for an agent handoff.

The overlay is a strict production no-op; its client plugin is only registered when Nuxt runs in development mode.

```ts
export default defineNuxtConfig({
  nuxtDx: {
    position: 'bottom-right',
  },
})
```

## Hydration mismatches

Hydration mismatches get their own count on the badge and their own section in the report. Vue hands them to `warnHandler` with the DOM nodes already flattened into the message, so the overlay parses that string back apart and pairs it with the component that was hydrating and its source file.

The badge reads `1 err | 1 warn | 5 hydration`, and the panel lists each mismatch as:

```
HYDRATION Class mismatch in <RandomBadge>
  file: app/components/RandomBadge.vue
  on: HTMLSpanElement
  server: class="warm"
  client: class="cool"
```

The copied report gets the same treatment, one heading per mismatch:

```md
### 2. Class mismatch in <RandomBadge>
- Component file: `app/components/RandomBadge.vue`
- Component chain: RandomBadge < Index < RouteProvider < RouterView < NuxtPage
- DOM node: `HTMLSpanElement`
- Server rendered: `class="warm"`
- Client rendered: `class="cool"`
```

Node, text, children, class, style, and attribute mismatches are all recognised. Vue's follow-up `Hydration completed but contains mismatches.` console error is dropped, since every mismatch behind it is already listed. Two reports of the same mismatch collapse into one entry: a mismatch is identified by where it happened rather than by the values it printed, so a clock rendering `Date.now()` does not stack up a new entry every time it drifts.

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

The three heaviest modules are listed and the remainder is folded into one line, so the breakdown always sums to the reported total. The suggested override is rounded up past the current size, and every offender lands in a single copy-pasteable snippet.

A plugin that declares a name gets reported by it, with the file kept alongside so the warning stays clickable:

```ts
export default defineNuxtPlugin({
  name: 'analytics',
  setup() {},
})
```

Both `defineNuxtPlugin({ name })` and `defineNuxtPlugin(fn, { name })` are read. Other entries use their path. If a Nuxt module registered an entry, warnings and reports include that module as its owner. Ownership is metadata and never creates a second charge.

## The size budget report

Reporting is off until you ask for it. With `report: true`, every build writes `.nuxt/dx/size-budget.json`. The report contains one entry per measured runtime entry.

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
  "version": 2,
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

Disabled entry kinds are omitted from reports. The client bundle requires `nuxi build`. Development runs only report Nitro entries.

## Catching regressions

An absolute budget catches a bundle that is already too big. It says nothing about the pull request that takes a healthy 12 kB plugin to 48 kB. `nuxt-dx compare` reads the report from two builds and fails when anything grew past a threshold:

```bash
nuxt-dx compare base/.nuxt/dx/size-budget.json .nuxt/dx/size-budget.json
```

```md
### Bundle size budget

- **Client runtime entries** 47.2 kB to 65.7 kB, **+18.5 kB**
  - Nuxt plugins: 34.7 kB to 61.8 kB, +27.1 kB
  - Nuxt middleware: 12.5 kB to 3.9 kB, -8.6 kB
- **Server runtime entries** 6.4 kB to 6.4 kB, **+0 B**
  - Nitro plugins: 6.4 kB to 6.4 kB, +0 B

**1 target grew past the 10 kB threshold:** `app/plugins/analytics.client.ts` +35.7 kB.

| Target | Module | Scope | Base | Head | Change |
| --- | --- | --- | --- | --- | --- |
| `app/plugins/analytics.client.ts` |  | Nuxt plugin | 7.6 kB | 43.3 kB | +35.7 kB |
| `runtime/consent.client.ts` | `fixture-consent` | Nuxt plugin | 0 B | 170 B | +170 B (new) |
| `app/middleware/legacy.global.ts` |  | Nuxt middleware | 12.5 kB | 3.9 kB | -8.6 kB |
```

Markdown goes to stdout for job summaries. The local verdict goes to stderr. Client and server totals combine their disjoint runtime entries.

`--threshold-kb` sets how much one target may grow before failure. The default is 10 kB. The threshold is per target. Bundle totals expose cumulative drift.

`--allow-missing-base` reports that there was no baseline and passes, rather than failing. Exit code 1 means something grew past the threshold, 2 means a report could not be read, and 0 means you are clear.

## GitHub Actions

The comparison runs after your existing build step, in the job you already have. Nothing is rebuilt for it, since your build already wrote the report.

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
  # the action lists workflow runs and downloads the baseline report from one
  actions: read

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

The baseline is the report left behind by the last successful run of the same workflow on the base branch, downloaded from that run's artifact. Every run uploads its own report, so a green run on `main` becomes the baseline for the pull requests that follow. Nothing is committed to your repository, so there is no baseline file to go stale or to conflict on every pull request.

A run with no baseline says so in the job summary and passes. That covers the first ever run, a branch whose artifact has passed its retention window, and a workflow that has never been green on the base branch. A missing baseline never fails a pull request.

The diff goes to `$GITHUB_STEP_SUMMARY`, which needs no write permissions and works on pull requests from forks. The step fails only when a target grew past the threshold.

| Input | Default | |
| --- | --- | --- |
| `report-path` | `.nuxt/dx/size-budget.json` | Report your build wrote, relative to `working-directory` |
| `threshold-kb` | `10` | Growth allowed for a single target |
| `artifact-name` | `nuxt-dx-size-budget-v2` | Artifact the report is uploaded to and read back from |
| `base-branch` | pull request base, then the default branch | Branch the baseline comes from |
| `working-directory` | `.` | Directory the app was built in |
| `github-token` | `${{ github.token }}` | Needs `actions: read` |

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
      // keyed by plugin name or any fragment of an entry path
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

Budgets are measured whenever a bundle is produced. Nitro entries report during development and builds. Client entries only report during builds.

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
