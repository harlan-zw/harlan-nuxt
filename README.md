<h1>Harlan Nuxt</h1>

[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Experimental Nuxt modules developed in one repo, so they share tooling and a single verification pipeline.

Every package here publishes under the `experimental` npm tag. Versions and release notes are per package, so one module moving fast never forces a version bump on the others.

<p align="center">
<table>
<tbody>
<td align="center">
<sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br> Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub><br>
</td>
</tbody>
</table>
</p>

## Packages

| Package | What it does |
| --- | --- |
| [`@harlan-zw/nuxt-cf-jobs`](./packages/nuxt-cf-jobs) | ☁️ Typed Cloudflare Queue jobs with file-based definitions, optional D1 durability, scheduled tasks, and an operations CLI. |
| [`@harlan-zw/nuxt-use-query`](./packages/nuxt-use-query) | 🔄 Nuxt-native queries, mutations, and subscriptions with SWR, invalidation, polling, and typed RPC contracts. |
| [`@harlan-zw/nuxt-domain-events`](./packages/nuxt-domain-events) | 📣 Layer-aware server domain events with generated lazy registries and after-commit queue publication. |
| [`@harlan-zw/nuxt-dx`](./packages/nuxt-dx) | 🚨 Diagnostics: a client error overlay with agent handoff, and bundle size budgets for Nuxt plugins, Nitro plugins, and Nuxt modules. |
| [`@harlan-zw/nuxt-github-sponsors`](./packages/nuxt-github-sponsors) | 💖 Typed GitHub Sponsors data with tiers, profile overrides, a public route, and a composable. |

## Development

Requires Node 22.12+ and pnpm.

```bash
pnpm install
pnpm dev:prepare
```

Run these from the repo root to cover every package, or from a package directory for just that one:

```bash
pnpm lint       # eslint, includes markdown and code blocks
pnpm typecheck  # nuxt typecheck / tsc per package
pnpm test       # vitest
pnpm build      # nuxt-module-builder / obuild
```

Packages are pnpm workspace members under `packages/*`. Shared dependency versions live in the `catalog:` block of `pnpm-workspace.yaml`, so bump a version there rather than in each package.

## Releases

Push a `<package>-v<version>` tag, for example `nuxt-dx-v0.0.2`. The trusted GitHub Actions publisher releases that package under the `latest` npm tag with provenance.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/LICENSE.md).

<!-- Badges -->
[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
