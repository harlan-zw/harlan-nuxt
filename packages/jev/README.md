# @harlan-zw/jev

Nuxt-free Jev judgements: one client, the `ask` tag API, digest helpers, and eval replay math. Jev is a System One judge: it answers typed questions about one state with probabilities. It never generates text.

Pure TypeScript with zero runtime dependencies: no Nuxt, no Nitro, no h3. Runs on Node 20+ and workers. Use `@harlan-zw/nuxt-jev` for the Nuxt module, the decision runner, and the drizzle schema.

## What you get

| Export | What it gives you |
| --- | --- |
| `createJevHttpClient` | The tagged-failure HTTP client over Cloudflare `/ai/run`: retries, backoff, one timeout window, and answer validation. |
| `noul`, `choice`, `score` | Question builders with typed answers. |
| `ask`, `ask.choice`, `ask.score`, `ask.chance`, `askIf` | Tagged-template sugar over the client. |
| `sha256Hex`, `canonicalJson` | Order-stable digests for journal keys. |
| `agreement`, `summarizeReplay`, `suggestBand`, `replayAnswer` | Pure eval replay math. |

## Failure style

Failures are values, never throws. The client resolves `{ _tag: 'Ok', result }` or `{ _tag: 'Err', failure }`, and every failure is one tagged `JevFailure`: `Http`, `Invalid`, `Network`, or `Timeout`. The `ask` API keeps the same contract: batches resolve to `{ _tag: 'Ok', answers }` or `{ _tag: 'Err', failure }`, and awaiting a tag on its own resolves to its answer or the same tagged failure. Nothing rejects.

## ask

```ts
import { ask } from '@harlan-zw/jev'

const result = await ask(
  { title: 'Crash on login', body: 'Anyone can log in as admin with an empty password.' },
  {
    security: 'Does this describe a security vulnerability?',
    kind: ask.choice`What kind of issue is this?`({ bug: 'Something is broken', other: null }),
    severity: ask.score`How severe?`(['Cosmetic', 'Workaround exists', 'Blocks production']),
  },
  { accountId, apiToken },
)
if (result._tag === 'Ok') {
  result.answers.security.chance // 0.9
  result.answers.kind.choice // 'bug'
  result.answers.severity.ratio // score scaled to 0 to 1
}
```

Interpolated objects go once each into `input` and their slots become paths, so the state travels with the question. Tags also send on their own when awaited. `askIf` resolves to a boolean above a threshold. Credentials come from options or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

## Client

```ts
import { createJevHttpClient, noul } from '@harlan-zw/jev'

const client = createJevHttpClient({ apiToken, accountId })
const call = await client.systemOne({
  state: { query: 'nuxtseo' },
  questions: { brand: noul('Is `query` a search for the site brand?') },
})
if (call._tag === 'Ok')
  call.result.answers.brand.noul
```

## License

MIT, see [LICENSE.md](./LICENSE.md). Forked from pithings/advocaat (MIT); question and answer shapes mirror github.com/typesafe-ai/typesafe-sdk-js.
