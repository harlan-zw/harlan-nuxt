# Jev

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]

> Ask Jev typed questions about one state and get probabilities back, with no Nuxt required.

## Why Jev?

A generative model answers a yes or no question with a paragraph. Your code then parses prose and guesses what it meant.

- 🧾 **Prose instead of answers**: You parse free text to get a boolean, a label, or a rank.
- 💥 **Thrown failures**: An HTTP error, a timeout, or a malformed answer throws in the middle of your request.
- 🔑 **Unstable journal keys**: The same state with keys in a different order hashes to a new digest, so a stored answer never gets reused.
- 🎚️ **Thresholds picked by feel**: Nothing tells you whether a probability band agrees with the answers you already have.

Jev is a System One judge. It answers typed questions about one state with probabilities. It never generates text. This package is the Nuxt-free client for it: pure TypeScript with one dependency, ohash, for sync digests. It has no Nuxt, Nitro, or h3 code, and runs on Node 20+ and workers. For the Nuxt module, the decision runner, and the drizzle schema, use [`@harlan-zw/nuxt-jev`](../nuxt-jev).

## Features

- ⚖️ **Typed questions**: `noul`, `choice`, and `score` return a probability, a picked option, or a rubric level, never prose.
- 🏷️ **`ask` tags**: Put the state and the question in one tagged template, and send a batch in one call.
- 🧯 **Failures as values**: Every call resolves `Ok` or a tagged `JevFailure`, so nothing throws and nothing rejects.
- 🔁 **Retries in the client**: The HTTP client retries with backoff inside one timeout window and validates each answer.
- 🔑 **Order-stable digests**: `digestKey` and `canonicalJson` give the same key for the same state, whatever the key order.
- 📊 **Eval replay math**: `summarizeReplay` and `suggestBand` measure agreement before you move a threshold.

## Installation

```bash
pnpm add @harlan-zw/jev
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/jev
> ```

## What you get

| Export | What it gives you |
| --- | --- |
| `createJevHttpClient` | The tagged-failure HTTP client over Cloudflare `/ai/run`: retries, backoff, one timeout window, and answer validation. |
| `noul`, `choice`, `score` | Question builders with typed answers. |
| `ask`, `ask.choice`, `ask.score`, `ask.chance`, `askIf` | Tagged-template sugar over the client. |
| `digestKey`, `canonicalJson` | Order-stable digests for journal keys. |
| `agreement`, `summarizeReplay`, `suggestBand`, `replayAnswer` | Pure eval replay math. |

## Failure style

Failures are values. Nothing throws and nothing rejects.

The client resolves `{ _tag: 'Ok', result }` or `{ _tag: 'Err', failure }`. Every failure is one tagged `JevFailure`: `Http`, `Invalid`, `Network`, or `Timeout`.

The `ask` API keeps the same contract. A batch resolves to `{ _tag: 'Ok', answers }` or `{ _tag: 'Err', failure }`. An awaited tag on its own resolves to its answer or the same tagged failure.

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

Each interpolated object goes once into `input`, and its slot becomes a path. The state travels with the question. If you await a tag on its own, it sends on its own. `askIf` resolves to a boolean above a threshold. Credentials come from options, or from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

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

## Jev 1.13 jagged edges

The model's own docs list its failure modes ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)). This package and its consumers follow these rules:

- **Math, counting, dates stay in code.** Never ask the model to tally, compare numbers, or order dates. Compute counts and buckets in code, then pass the value or a named bucket in state. Use Score answers to rank and threshold. Never infer a magnitude between two rubric levels.
- **Literal reading.** Write the exact condition in `instructions`. Put boundary cases in `criteria`. If a question needs interpretation, split it into two literal questions and combine them in code.
- **Criteria extend the instruction.** A `true` that means "no" gives worse answers. Keep the two aligned.
- **Thresholds do not carry across question types.** A Noul band and a Choice confidence answer different questions. `noul` compares with `probabilities['yes']`, not with `confidence`. A question and its negation do not sum to 1. Tune each threshold on its own question. Never expect arithmetic identities between separate answers.
- **Choice settles "which"; Noul settles "whether".** A Choice is relative: it picks one option. Each Noul is absolute: all of them can be low. If you need both answers, ask both on the same shortlist.
- **Filter state before sending.** Unrelated detail costs accuracy (context rot), and the context window has a limit. Send only the fields the question names.
- **Adversarial content is data the model does not treat as hostile.** Frame untrusted text as measurements to judge, never as instructions. Test those edges before you act on answers in production.
- **No generation.** If the answer space is bounded, extract the options in code or with a generative model. Then let Jev pick one.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/jev/LICENSE.md). Forked from pithings/advocaat (MIT); question and answer shapes mirror github.com/typesafe-ai/typesafe-sdk-js.

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fjev/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/jev

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fjev.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/jev

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/jev/LICENSE.md
