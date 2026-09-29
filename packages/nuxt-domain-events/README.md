<h1>@harlan-zw/nuxt-domain-events</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Domain Events lets a producer fire a server-side domain event without importing any listener that handles it. The module generates a registry for each layer and imports it lazily.

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

- 🗂️ **Generated lazy registries:** a producer never imports its listeners, so a new listener in any layer leaves the producer untouched.
- 🎚️ **Explicit execution modes:** a listener never runs later or in a queue by surprise, because every mode except serial synchronous is an opt-in.
- 📦 **Two contract kinds:** request-scoped state never leaks into a queue, because only `transfer` contracts reach queued listeners.
- 🏷️ **Errors as tagged values:** you branch on a known tag, such as payload mismatch or registry drift, instead of parsing error messages.
- 💾 **After-commit publication:** a rolled-back transaction leaves no queue rows, so no listener acts on data that never committed.
- 🚰 **One-call deferred drain:** producers stop repeating the same collect-and-drain loop for deferred work.

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

Listeners work like Laravel listeners. If you omit `execution`, listeners run one at a time, synchronously, and a failure propagates. That failure aborts the producer. It also stops deferred work and queue publication. To change this, opt into `sync` isolation, `deferred`, or `queued`.

A queued listener cannot declare `shouldHandle`. A synchronous or deferred listener can use it as an in-process condition. A queued listener can declare a `failed(payload, context, error)` callback. The module calls it after the delivery reaches its final outcome.

## Deferred dispatch

`dispatchEvent` schedules deferred listeners through `context.waitUntil`. `dispatchEventAndDrain` saves each producer from writing its own collect-and-drain loop:

```ts
await dispatchEventAndDrain('user:registered', payload, {
  waitUntil: event.context.cloudflare?.context?.waitUntil?.bind(event.context.cloudflare.context),
})
```

If the host supplies `waitUntil`, the call hands deferred work to it. If not, the call awaits deferred work before it resolves. In both cases, a deferred failure stays isolated.

## Queues

`domainEvents.queues` names the logical queues that queued listeners may use. To derive the list from `cfJobs.queues`, omit it or set it to `[]`.

## Observer

`domainEvents.observer` names a server module that exports `observeEventListener`. A relative path resolves against the layer that declares it, so a layer can ship its own observer. If you configure no observer, the build warns. Listener and dispatch failures then reach stderr only.

## Event contracts

A `local` contract can carry request-scoped or mutable state. It supports synchronous listeners and deferred `waitUntil` listeners in the same isolate. It never supports queued delivery.

A `transfer` contract owns a versioned JSON codec and a byte limit. Queued delivery parses the payload with that contract before it imports or calls the listener.

## Errors

A runtime error is a tagged `Error` value, and it rejects dispatch. The expected tags are unknown event, payload mismatch, lazy import failure, registry drift, queue failure, and after-commit misuse. If the observer itself fails, the module calls the configured fallback, or `console.error`. The business outcome and its label stay the same.

## Queued listeners

A queued listener needs explicit idempotency, and the caller must pass a stable `eventId`. The module derives a stable delivery ID from `eventId + listenerName`. Producer dispatch never imports a queued listener implementation.

## After-commit events

The after-commit flow calls `planEvent`, then `commitEventPlan`. Every listener for that event must be queued with `publication: 'after-commit'`. A D1 batch is non-interactive. So it cannot run ordinary listeners after domain SQL and still let their failure roll back that SQL. If one producer needs both ordinary and after-commit listeners, split the event contract.

The caller supplies the unit of work. It stages the adapter's unpublished D1 statements beside the domain writes. On rollback, it returns `rolled-back` and leaves no publication rows. Otherwise, it returns the adapter's exact staged-delivery receipt, and only after D1 resolves. A failed send stays as an unpublished durable row, so you can recover it.

## Cloudflare Jobs adapter

You pass the public `@harlan-zw/nuxt-cf-jobs/outbox` functions to the `./cf-jobs` adapter, which types them by shape. So the event core stays runtime-neutral, and the dependency runs one way. The adapter's generic delivery definition declares the static `maintenance` queue, for `@harlan-zw/nuxt-cf-jobs` registry locality. The public outbox route override then stores each listener job on the queue that listener declares.

## Not supported

The module does not support these: mixed ordinary and after-commit listeners on one transaction-bound event, producer-time Laravel `shouldQueue`, cooperative listener timeouts, listener ordering contracts, grouped subscriber modules, dashboards, CLI, and compatibility shims.

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
