# Harlan Nuxt

[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

> Nuxt modules and companion packages that share tooling and one verification pipeline.

Each package publishes to npm with provenance. Each package has its own version and release notes, so a fast-moving module never forces a version bump on the others.

## Packages

| Package | npm | What it does |
| --- | --- | --- |
| [Nuxt Check-in](./packages/nuxt-checkin) | `@harlan-zw/nuxt-checkin` | ✅ Deterministic server checks from site files and existing modules. |
| [Nuxt CF Jobs](./packages/nuxt-cf-jobs) | `@harlan-zw/nuxt-cf-jobs` | ☁️ Typed Cloudflare Queue jobs with file-based definitions, optional D1 durability, scheduled tasks, and an operations CLI. |
| [Nuxt Use Query](./packages/nuxt-use-query) | `@harlan-zw/nuxt-use-query` | 🔄 Nuxt-native queries, mutations, and subscriptions with SWR, invalidation, polling, and typed RPC contracts. |
| [Nuxt Domain Events](./packages/nuxt-domain-events) | `@harlan-zw/nuxt-domain-events` | 📣 Layer-aware server domain events with generated lazy registries and after-commit queue publication. |
| [Nuxt DX](./packages/nuxt-dx) | `@harlan-zw/nuxt-dx` | 🚨 Diagnostics: a client error overlay with agent handoff, and JavaScript budgets for Nuxt and Nitro runtime entries. |
| [Nuxt GitHub Sponsors](./packages/nuxt-github-sponsors) | `@harlan-zw/nuxt-github-sponsors` | 💖 Typed GitHub Sponsors data with tiers, profile overrides, a public route, and a composable. |
| [Nuxt Wide Events](./packages/nuxt-wide-events) | `@harlan-zw/nuxt-wide-events` | 📝 Minimal Wide Events with build-time Field enforcement and a small production runtime. |
| [Jev](./packages/jev) | `@harlan-zw/jev` | ⚖️ Nuxt-free Jev client, ask tags, digest helpers, and eval replay math. |
| [Nuxt Jev](./packages/nuxt-jev) | `@harlan-zw/nuxt-jev` | ⚖️ Jev decision runner with journal reuse and the drizzle decisions table, wired for Nuxt. |
| [Nuxt Cloudflare](./packages/nuxt-cloudflare) | `@harlan-zw/nuxt-cloudflare` | 🌩️ Opinionated Cloudflare defaults, generated Wrangler config, and Wrangler diagnostics for Nuxt. |
| [Nuxt Sentry](./packages/nuxt-sentry) | `@harlan-zw/nuxt-sentry` | 🛡️ One Sentry Report Policy: registration, enable gate, Drop Rules, and Redaction Rules for the client and the server. |
| [MCP OAuth](./packages/mcp-oauth) | `@harlan-zw/mcp-oauth` | 🔐 Framework-free Policy Rules for an MCP OAuth 2.1 server: mandatory PKCE, consent identity, CSRF, bearer challenges. |
| [Comark Content](./packages/comark-content) | `@harlan-zw/comark-content` | 📄 Markdown-only Nuxt content powered by Comark, with Collection queries, navigation, and search sections. |

## Development

Requires Nuxt 4.6 or Nuxt 5 and pnpm. Supported Node versions: `^22.22.3 || ^24.15.0 || >=26.0.0`.

```bash
pnpm install
pnpm dev:prepare
```

Run these from the repo root for every package. Run them from a package directory for that package only:

```bash
pnpm lint       # eslint, includes markdown and code blocks
pnpm typecheck  # nuxt typecheck / tsc per package
pnpm test       # vitest
pnpm build      # nuxt-module-builder / obuild
```

Packages are pnpm workspace members under `packages/*`. Shared dependency versions live in the `catalog:` block of `pnpm-workspace.yaml`. Bump a shared version there, not in each package.

## Releases

First, merge the package version bump through a pull request. Then run from the repo root:

```bash
pnpm release                         # choose a package and confirm publishing
pnpm release nuxt-dx --dry-run        # preview the version, commit, and tag
pnpm release nuxt-dx --yes            # publish without a prompt
```

The command reads the version from `origin/main` and pushes its `<package>-v<version>` tag.
It rejects existing tags and prerelease versions.
The trusted GitHub Actions publisher then publishes that package to npm under the `latest` tag, with provenance.

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
