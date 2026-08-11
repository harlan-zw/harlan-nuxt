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
- 📦 **Size budgets:** warn when a Nuxt plugin, a Nitro plugin, or an installed Nuxt module drags too much JavaScript into the bundle, so you can answer which of your modules cost you 80 kB.
- 🔍 **Exclusive attribution and overrides:** each plugin and module is charged only for what it alone pulls in, with budgets keyed by plugin name, module name, or path fragment.

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
