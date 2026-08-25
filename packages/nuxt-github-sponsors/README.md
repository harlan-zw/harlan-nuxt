<h1>@harlan-zw/nuxt-github-sponsors</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt GitHub Sponsors fetches your GitHub sponsors and hands them to your app as typed data. It ships no UI, so your sponsor page stays yours to design.

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

- 🔌 **Route and composable:** a public route plus `useGitHubSponsors()` for a typed response, paginated across every active sponsorship.
- 🔒 **Private sponsors filtered:** only a minimal public DTO leaves the server.
- 🏅 **Tiers and overrides:** assign tier keys by minimum monthly amount, and correct names, avatars, and links without patching GitHub.
- 🔤 **Tier keys typed from config:** a page that reads a renamed tier fails to compile.
- ⚡ **One-day SWR cache:** only successful upstream results are cached.
- 🎨 **Headless by design:** no sponsor UI, so your visual identity stays yours.

## Installation

```bash
pnpm add @harlan-zw/nuxt-github-sponsors
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-github-sponsors
> ```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-github-sponsors'],
  githubSponsors: {
    login: 'your-github-login',
  },
})
```

Set `NUXT_GITHUB_SPONSORS_TOKEN`. The token must be a classic token, because a
fine-grained token cannot call the GitHub GraphQL API.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `login` | required | GitHub login to read sponsorships for. |
| `mode` | `'prerender'` | See Modes. |
| `route` | `'/api/github-sponsors'` | Public route serving the response. |
| `tiers` | `top` at $50, `gold` at $25 | Tier keys, by minimum monthly amount. |
| `overrides` | `{}` | Corrections by sponsor login or name. |
| `tokenEnv` | `'NUXT_GITHUB_SPONSORS_TOKEN'` | Env name holding the token. |

Set `tokenEnv` when the default name is already taken:

```ts
export default defineNuxtConfig({
  githubSponsors: {
    login: 'your-github-login',
    tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN',
  },
})
```

## Modes

`prerender` bakes the route at build. It needs the token at build time. If the
token is absent, the module warns and skips the prerender, so no empty sponsor
list is baked into the deploy.

`runtime` serves the route from the server with a one-day SWR cache.

`client` skips server rendering. The page fetches after mount, so sponsors stay
out of the rendered HTML and need no `onMounted` gate of your own.

## Tier keys

The module types the tier keys from your configured tiers, so `tiers.top` is
checked against your config. Renaming a tier turns a silently empty page into a
compile error.

## Usage

The module registers a public route and `useGitHubSponsors`. The server core fetches all active sponsorship pages, parses GitHub responses, filters private sponsors, projects a minimal public DTO, applies explicit profile overrides, and assigns configurable tiers.

There is no sponsor UI in this package. Each site keeps its own visual identity and calls `useGitHubSponsors()` for a typed response.

## Failure states

The route always answers `200` with a tagged state. `unavailable` with reason
`not-configured` means no token. `unavailable` with reason `upstream-error`
carries an `errorTag` naming the upstream fault. Both states carry an empty
collection, so a page renders and a prerender with `failOnError` still builds.
Only a successful upstream result is cached. No secret is logged.

Override keys that match no sponsor are reported in a server warning, because a
key with a typo would otherwise do nothing at all.

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
