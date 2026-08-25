<h1>@harlan-zw/nuxt-domain-events</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Domain Events lets a producer fire a server-side event without importing any of the listeners that handle it. Registries are generated per layer and imported lazily.

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

- 🗂️ **Generated lazy registries:** layer-aware, so producers never import a queued listener implementation.
- 🎚️ **Explicit execution modes:** serial synchronous by default, with `sync` isolation, `deferred`, and `queued` as opt-ins.
- 📦 **Two contract kinds:** `local` for request-scoped state, `transfer` for versioned JSON with a byte limit.
- 🏷️ **Errors as tagged values:** unknown event, payload mismatch, lazy import failure, registry drift, queue failure, and after-commit misuse.
- 💾 **After-commit publication:** stage queue rows beside domain SQL so a rollback leaves zero queue evidence.
- 🚰 **One-call deferred drain:** `dispatchEventAndDrain` hands deferred work to the host `waitUntil`, or awaits it.

## Installation

```bash
pnpm add @harlan-zw/nuxt-domain-events
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-domain-events
> ```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-domain-events'],
})
```

## Execution modes

Listeners run like Laravel listeners. Omitting `execution` means serial synchronous execution with propagated failure. That failure aborts the producer and prevents deferred work or queue publication. `sync` isolation, `deferred`, and `queued` are explicit alternatives.

Queued listeners cannot declare `shouldHandle`; synchronous and deferred listeners may use it as an in-process condition. Queued listeners may declare a functional `failed(payload, context, error)` callback, invoked after terminal settlement.

## Deferred dispatch

`dispatchEvent` schedules deferred listeners through `context.waitUntil`. `dispatchEventAndDrain` removes the collect-and-drain loop from every producer:

```ts
await dispatchEventAndDrain('user:registered', payload, {
  waitUntil: event.context.cloudflare?.context?.waitUntil?.bind(event.context.cloudflare.context),
})
```

If the host supplies `waitUntil`, deferred work is handed to it. If the host has no `waitUntil`, the deferred work is awaited before the call resolves. Deferred failures stay isolated in both paths.

## Queues

`domainEvents.queues` names the logical queues that queued listeners may use. Omit it, or set it to `[]`, to derive the list from `cfJobs.queues`.

## Observer

`domainEvents.observer` names a server module that exports `observeEventListener`. A relative path resolves against the layer that declares it, so a layer can ship its own observer. If no observer is configured, the module warns at build, and listener and dispatch failures reach stderr only.

## Event contracts

`local` event contracts may carry request-scoped or mutable state. They support synchronous listeners and same-isolate deferred `waitUntil` listeners, but never queued delivery.

`transfer` contracts own a versioned JSON codec and byte limit. Queued delivery parses that contract before importing or invoking the selected listener.

## Errors

Runtime errors are tagged `Error` values and reject dispatch. Expected tags include unknown event, payload mismatch, lazy import failure, registry drift, queue failure, and after-commit misuse. Observer defects run the configured fallback, or `console.error`, without changing or relabelling the business outcome.

## Queued listeners

Queued listeners require explicit idempotency and a caller-provided stable `eventId`. The generated delivery ID is stable from `eventId + listenerName`. Producer dispatch never imports a queued listener implementation.

## After-commit events

After-commit flow uses `planEvent`, then `commitEventPlan`. In v1, every listener for that event must be queued with `publication: 'after-commit'`. D1 batch is non-interactive, so it cannot run ordinary listeners after domain SQL while still allowing their failure to roll back that SQL. Split the event contract when one producer needs both ordinary and after-commit listeners.

The caller-supplied unit of work stages the adapter's unpublished D1 statements beside domain writes. It returns `rolled-back` with zero queue evidence, or the adapter's exact staged-delivery receipt only after D1 resolves. A failed send remains an unpublished durable row for recovery.

## Cloudflare Jobs adapter

The `./cf-jobs` adapter accepts the public `@harlan-zw/nuxt-cf-jobs/outbox` functions structurally. This keeps the event core runtime-neutral and the dependency one-way. Its generic delivery definition declares the static `maintenance` queue for `@harlan-zw/nuxt-cf-jobs` registry locality; the public outbox route override stores each listener job on the queue declared by that listener.

## Not in v1

Deferred for now: mixed ordinary and after-commit listeners on one transaction-bound event, producer-time Laravel `shouldQueue`, cooperative listener timeouts, listener ordering contracts, grouped subscriber modules, dashboards, CLI, and compatibility shims.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-domain-events/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-domain-events/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-domain-events

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-domain-events.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-domain-events

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-domain-events/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
