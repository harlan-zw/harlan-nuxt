# Nuxt Jev

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

> Run Jev judgements from Nuxt server code, with journal reuse and per-seat rollout.

## Why Nuxt Jev?

A model call inside a server route runs on every request. When it fails, the route still needs an answer.

- 💸 **Repeat calls**: The same question about the same state goes to the network again on every request.
- 🚧 **Failures break the route**: A timeout or a bad answer turns into an error for the user.
- 🎛️ **All or nothing rollout**: A new judgement acts on production traffic before you know it agrees with reality.
- 🔓 **Missing credentials**: A site with no Cloudflare token still tries the call and fails.

Nuxt Jev is the Nuxt layer for Jev typed judgements. It adds module config, a decision runner with journal reuse, and the drizzle schema. Jev is a System One judge. It answers typed questions about one state with probabilities. It never generates text. The client, question builders, ask tags, and eval math live in [`@harlan-zw/jev`](../jev), the Nuxt-free base package.

## Features

- ♻️ **Journal reuse**: The same seat, subject, state, and question version reads the stored row, with no network call.
- 🧯 **Tagged decisions**: `decideJev` resolves `Answer`, `Unavailable`, or `Unconfigured`, so the caller keeps its safe direction.
- 🎛️ **Seat modes**: Set each seat to `off`, `shadow`, or `live`, and act only on live seats.
- 🔓 **Unconfigured by default**: With no `apiToken` and `accountId`, no rows are written and no network call is made.
- 🗄️ **Drizzle table factory**: `createJevDecisionsTable()` gives a sqlite table for D1 or better-sqlite, with room for extra columns.
- 🧪 **In-memory journal**: `createInMemoryJevJournal()` runs the same runner in tests without a database.

## Installation

```bash
npx nuxi@latest module add @harlan-zw/nuxt-jev
```

If you import question builders such as `noul` in your own code, add `@harlan-zw/jev` too:

```bash
pnpm add @harlan-zw/jev
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-jev
> ```

## Exports

| Export | What it gives you |
| --- | --- |
| `@harlan-zw/nuxt-jev` | The Nuxt module. Registers `runtimeConfig.jev` defaults. |
| `@harlan-zw/nuxt-jev/server` | Config and seat-mode resolution, plus the `decideJev` runner over an injected journal. |
| `@harlan-zw/nuxt-jev/schema` | `createJevDecisionsTable(extraColumns?)`: the drizzle sqlite table factory. |
| `@harlan-zw/jev` | The Nuxt-free base: HTTP client, question builders, ask tags, digest helpers, eval math. |

## Safety rules

| Situation | Behaviour |
| --- | --- |
| `state` null or undefined | A programming error. `decideJev` throws a `TypeError` before any network call. |
| No `apiToken` and `accountId` | `Unconfigured`. No rows and no network. The caller keeps its current behaviour. |
| HTTP, network, timeout, or invalid answer | `Unavailable`. No row is written. The caller keeps its safe direction. |
| Same seat, subject, state, and question version | `reuse`. The journaled row answers, with no network call. |
| Insert loses a unique race | `decideJev` reads the winner row again and reuses it. |
| Seat mode | `off`, `shadow`, or `live` per seat, from `seatModes` pairs. The default is `shadow`. |
| Eval suggestion | Evidence, never an action. It needs 30 answered samples, 10 in the band, and 95% agreement in the band. Ten or more outcomes below 90% accuracy veto every suggestion. |

## Environment keys

| Key | Purpose |
| --- | --- |
| `NUXT_JEV_API_TOKEN` | Cloudflare API token. If empty, Jev is unconfigured. |
| `NUXT_JEV_ACCOUNT_ID` | Cloudflare account id. If empty, Jev is unconfigured. |
| `NUXT_JEV_GATEWAY_ID` | Optional AI Gateway id. |
| `NUXT_JEV_MODEL` | Default `typesafe/jev`. |
| `NUXT_JEV_CACHE_TTL` | Seconds for `cf-aig-cache-ttl`. Zero omits the header. |
| `NUXT_JEV_SEAT_MODES` | Comma-separated seat=mode pairs. Each mode is `off`, `shadow`, or `live`. |
| `NUXT_JEV_DEFAULT_MODE` | Mode for seats without a pair. Default `shadow`. |

## Consumption sketch

Register the module and merge the table into your schema.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-jev'],
  runtimeConfig: {
    jev: { seatModes: 'brand-query=live,ctr-outlier=shadow' },
  },
})
```

```ts
// server/database/schema.ts (drizzle, D1 or better-sqlite)
import { createJevDecisionsTable } from '@harlan-zw/nuxt-jev/schema'

export const jevDecisions = createJevDecisionsTable()
```

```ts
// any server code
import { noul } from '@harlan-zw/jev'
import { createInMemoryJevJournal, decideJev, resolveJevConfig, resolveJevSeatMode } from '@harlan-zw/nuxt-jev/server'

const config = resolveJevConfig(useRuntimeConfig().jev)
const decision = await decideJev({
  journal: myDrizzleJournal, // find / insert / isUniqueViolation over jevDecisions
  config,
  seat: 'brand-query',
  questionVersion: 'v1',
  subject: 'q:nuxtseo',
  state: { query, brandTerms },
  questions: { brand: noul('Is `query` a search for the site brand?') },
  siteId: site.id,
})
if (decision._tag === 'Answer' && resolveJevSeatMode('brand-query', config) === 'live') {
  // act on decision.answers.brand.noul
}
```

For tests, or if you have no database, use `createInMemoryJevJournal()`.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-jev/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-jev/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-jev

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-jev.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-jev

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-jev/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
