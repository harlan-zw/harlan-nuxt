# @harlan-zw/nuxt-jev

The Nuxt layer for Jev typed judgements: module config, a decision runner with journal reuse, and the drizzle schema. The client, question builders, ask tags, and eval math live in [`@harlan-zw/jev`](../jev), a nuxt-free base package. Jev is a System One judge: it answers typed questions about one state with probabilities. It never generates text.

## Exports

| Export | What it gives you |
| --- | --- |
| `@harlan-zw/nuxt-jev` | The Nuxt module. Registers `runtimeConfig.jev` defaults. |
| `@harlan-zw/nuxt-jev/server` | Config and seat-mode resolution, plus the `decideJev` runner over an injected journal. |
| `@harlan-zw/nuxt-jev/schema` | `createJevDecisionsTable(extraColumns?)`: the drizzle sqlite table factory. |
| `@harlan-zw/jev` | The nuxt-free base: HTTP client, question builders, ask tags, digest helpers, eval math. |

## Safety rules

| Situation | Behaviour |
| --- | --- |
| No `apiToken` and `accountId` | `Unconfigured`. No rows, no network, caller keeps today's behaviour. |
| HTTP, network, timeout, or invalid answer | `Unavailable`. No row written, caller keeps its safe direction. |
| Same seat, subject, state, and question version | `reuse`. The journaled row answers; no network call. |
| Insert loses a unique race | The winner row is re-read and reused. |
| Seat mode | `off`, `shadow`, or `live` per seat from `seatModes` pairs; default `shadow`. |
| Eval suggestion | Evidence, never an action. Needs 30 answered samples, 10 in band, 95% agreement. Ten or more outcomes below 90% accuracy vetoes. |

## Environment keys

| Key | Purpose |
| --- | --- |
| `NUXT_JEV_API_TOKEN` | Cloudflare API token. Empty means unconfigured. |
| `NUXT_JEV_ACCOUNT_ID` | Cloudflare account id. Empty means unconfigured. |
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

`createInMemoryJevJournal()` ships for tests and for consumers without a database.

## License

MIT, see [LICENSE.md](./LICENSE.md).
