<h1>@harlan-zw/nuxt-github-sponsors</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt GitHub Sponsors gives your site typed access to your GitHub sponsors, without shipping a UI you then have to fight.

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

- 🔌 **Route and composable:** a public route plus `useGitHubSponsors()` for a typed response.
- 📄 **Full pagination:** fetches every active sponsorship page, not just the first.
- 🔒 **Private sponsors filtered:** only a minimal public DTO leaves the server.
- 🏅 **Configurable tiers:** assign tier keys by minimum monthly amount.
- ✏️ **Profile overrides:** correct names, avatars, and links without patching GitHub.
- ⚡ **One-day SWR cache:** only successful upstream results are cached.
- 🎨 **Headless by design:** no sponsor UI, so your visual identity stays yours.

## Installation

```bash
pnpm add @harlan-zw/nuxt-github-sponsors
```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-github-sponsors'],
  githubSponsors: {
    login: 'your-github-login',
    mode: 'runtime', // or 'prerender'
    tiers: [
      { key: 'partner', minimumMonthlyDollars: 50 },
      { key: 'supporter', minimumMonthlyDollars: 25 },
    ],
  },
})
```

Set `NUXT_GITHUB_SPONSORS_TOKEN` at runtime.

## Usage

The module registers a public route and `useGitHubSponsors`. The server core fetches all active sponsorship pages, parses GitHub responses, filters private sponsors, projects a minimal public DTO, applies explicit profile overrides, and assigns configurable tiers.

The package intentionally has no sponsor UI. Each site keeps control of its visual identity and calls `useGitHubSponsors()` for a typed response.

## Failure states

The route returns an explicit `unavailable` state with reason `not-configured` when no token exists, and a `502` response when GitHub cannot be refreshed. No secret is logged.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-github-sponsors/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-github-sponsors/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-github-sponsors

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-github-sponsors.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-github-sponsors

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-github-sponsors/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
