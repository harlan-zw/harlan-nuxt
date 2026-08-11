<h1>@harlan-zw/nuxt-dx</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt DX is a diagnostics module that surfaces problems you would otherwise have to go looking for: client errors while you develop, and the plugins and modules that quietly bloat your bundle when you build.

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
- 📦 **Size budgets with exclusive attribution:** warn when a Nuxt plugin, a Nitro plugin, or an installed Nuxt module drags too much JavaScript into the bundle, each charged only for what it alone pulls in, with budgets keyed by plugin name, module name, or path fragment.
- 📈 **Regression diffs:** every build writes a machine-readable report of what each plugin and module costs, and `nuxt-dx compare` diffs two of them so the pull request that quietly adds 40 kB fails instead of landing.

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

## Plugin size budgets

Warns when a Nuxt app plugin or a Nitro plugin drags too much JavaScript into the bundle.

Each plugin is charged its own bundled size plus every module reachable *only* through it. Anything the app already ships without going through that plugin, or that a second plugin also pulls in, is shared and charged to nobody. Sizes are post-tree-shaking bytes read off the final module graph, so the number reflects what actually ships.

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

Both `defineNuxtPlugin({ name })` and `defineNuxtPlugin(fn, { name })` are read. Plugins without a name are reported by path, as are Nitro plugins, which have no name concept.

## Module size budgets

Answers the question a plugin budget cannot: you installed five modules, which one added 80 kB to the client bundle?

Every bundled file that ships from a module's own package is charged to that module, along with everything those files reach exclusively. A dependency two modules both import is shared, so neither is billed for it, and the number moves as your app changes: install a second module that also uses `cookie-es` and the first module's charge drops by that much.

```
[nuxt-dx]  WARN  2 Nuxt modules over budget in the client bundle

  @nuxtjs/i18n
  57.2 kB bundled, 52.2 kB over the 5 kB budget
    ├─48.3 kB  the module's own files
    ├─ 6.1 kB  @intlify/shared/dist/shared.mjs
    ├─ 2.5 kB  h3/dist/index.mjs
    └─  276 B  virtual:nuxt:.nuxt%2Fi18n-options.mjs

  nuxt-site-config
  5.2 kB bundled, 252 B over the 5 kB budget
    ├─2.7 kB  the module's own files
    ├─2.3 kB  site-config-stack/dist/index.mjs
    └─ 219 B  virtual:nuxt:.nuxt%2Fnuxt-site-config%2Fi18n-plugin-deps.mjs

  Defer heavy imports with `await import()`, or allow the size:
    nuxtDx.sizeBudget.overridesKb = { '@nuxtjs/i18n': 58, 'nuxt-site-config': 6 }
```

Modules are reported by the name they declare in their own `meta`, which is also the key an override takes. Modules you never installed yourself show up too, `nuxt-site-config` above arrived as a dependency of another module, and it is charged like any other.

## The size budget report

Every build writes what it measured to `.nuxt/dx/size-budget.json`, whether or not anything breached a budget. It is the input to the regression check below, and it is readable on its own: one entry per Nuxt plugin, Nitro plugin, and installed Nuxt module, with the bytes broken down the same way the warning breaks them down.

```json
{
  "version": 1,
  "entries": [
    {
      "scope": "client",
      "path": "app/plugins/analytics.client.ts",
      "ownBytes": 182,
      "exclusiveBytes": 7626,
      "totalBytes": 7808
    },
    {
      "scope": "modules",
      "name": "fixture-telemetry",
      "path": "modules/telemetry",
      "ownBytes": 12834,
      "exclusiveBytes": 0,
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

`scope` is `client` for a Nuxt app plugin, `nitro` for a Nitro plugin, and `modules` for an installed Nuxt module. Paths are relative to the app root so two checkouts of the same repository agree on them. Modules carry the name they declare; plugins are keyed by path, since a plugin's declared name is only read for the plugins close enough to their budget to need it.

Only the scopes you left enabled are measured, so `pluginsKb: false` also drops plugins from the report. The client bundle is only built by `nuxi build`, so a `nuxi dev` run writes the Nitro plugins alone.

## Catching regressions

An absolute budget catches a bundle that is already too big. It says nothing about the pull request that takes a healthy 12 kB plugin to 48 kB. `nuxt-dx compare` reads the report from two builds and fails when anything grew past a threshold:

```bash
nuxt-dx compare base/.nuxt/dx/size-budget.json .nuxt/dx/size-budget.json
```

```md
### Bundle size budget

53.6 kB to 72.1 kB, **+18.5 kB** across 5 targets.

**1 target grew past the 10 kB threshold:** `app/plugins/analytics.client.ts` +35.7 kB.

| Target | Scope | Base | Head | Change |
| --- | --- | --- | --- | --- |
| `app/plugins/analytics.client.ts` | Nuxt plugin | 7.6 kB | 43.3 kB | +35.7 kB |
| `app/plugins/consent.client.ts` | Nuxt plugin | 0 B | 170 B | +170 B (new) |
| `app/plugins/legacy.client.ts` | Nuxt plugin | 159 B | 0 B | -159 B (gone) |
| `fixture-telemetry` | Nuxt module | 12.5 kB | 3.9 kB | -8.6 kB |
| `modules/telemetry/runtime/plugin.ts` | Nuxt plugin | 12.5 kB | 3.9 kB | -8.6 kB |
```

Markdown goes to stdout so it can be redirected straight into a job summary; the pass or fail line goes to stderr so a local run still reads as one. Targets that held still are counted rather than listed.

`--threshold-kb` sets how much a single target may grow before this fails, defaulting to 10. Each target is judged on its own, so a 40 kB regression is caught even when an unrelated cleanup makes the totals look flat. Exit code 1 means something grew past the threshold, 2 means a report could not be read, and 0 means you are clear.

### In GitHub Actions

Check out both commits, build both, and diff the two reports. Nothing is stored between runs, so there is no baseline file to go stale, and `$GITHUB_STEP_SUMMARY` needs no permissions and works on pull requests from forks.

```yaml
name: Size budget

on: pull_request

permissions:
  contents: read

jobs:
  size-budget:
    runs-on: ubuntu-24.04
    steps:
      - name: Check out the pull request
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.0.0
        with:
          persist-credentials: false

      - name: Check out the base commit
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.0.0
        with:
          path: .base
          persist-credentials: false
          ref: ${{ github.event.pull_request.base.sha }}

      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.2.0
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.0.0
        with:
          node-version: 24
          cache: pnpm

      - name: Build the base commit
        working-directory: .base
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      - name: Build the pull request
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      - name: Compare
        run: >
          pnpm exec nuxt-dx compare
          .base/.nuxt/dx/size-budget.json
          .nuxt/dx/size-budget.json
          >> "$GITHUB_STEP_SUMMARY"
```

The diff lands in the job summary either way; the step only fails when something grew past the threshold. Raise the bar for a pull request that legitimately ships something big by passing `--threshold-kb`.

## Configuring budgets

```ts
export default defineNuxtConfig({
  nuxtDx: {
    sizeBudget: {
      // kB budget per Nuxt app plugin in the client bundle, `false` to disable
      pluginsKb: 20,
      // kB budget per Nitro plugin in the server bundle, `false` to disable
      nitroPluginsKb: 50,
      // kB budget per Nuxt module in the client bundle, `false` to disable
      modulesKb: 50,
      // raise or lower the budget for individual plugins and modules,
      // keyed by plugin name, module name, or any fragment of the path
      overridesKb: {
        'analytics': 60,
        '@nuxtjs/i18n': 80,
        'server/plugins/queue': 120,
      },
      // where the machine-readable report is written, relative to the app root
      reportPath: '.nuxt/dx/size-budget.json',
      // throw instead of warning
      fail: false,
    },
  },
})
```

Set `sizeBudget: false` to turn the check off entirely.

Budgets are measured whenever a bundle is produced. Nitro is bundled in both `nuxi dev` and `nuxi build`, so Nitro plugin budgets report in either. The client is served unbundled in dev, so app plugin and module budgets only report on `nuxi build`.

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
