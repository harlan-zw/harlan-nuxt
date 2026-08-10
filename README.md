# Harlan Nuxt

Experimental public Nuxt packages maintained together for shared tooling,
consistent verification, and independent releases.

## Packages

| Package | Purpose |
| --- | --- |
| `@harlan-zw/nuxt-cf-jobs` | Typed Cloudflare queue jobs for Nuxt. |
| `@harlan-zw/nuxt-use-query` | Nuxt-native queries, mutations, subscriptions, and RPC. |
| `@harlan-zw/nuxt-domain-events` | Lazy server-side domain events and listeners. |
| `@harlan-zw/nuxt-dx` | Development-only Nuxt diagnostics and agent handoff. |
| `@harlan-zw/nuxt-github-sponsors` | Typed GitHub Sponsors data, tiers, route, and composable. |

All packages are experimental. Package versions and release notes are independent.

## Releases

Push a `<package>-v<version>` tag, for example `nuxt-dx-v0.0.2`. The trusted
GitHub Actions publisher releases that package under the `experimental` npm tag
with provenance.
