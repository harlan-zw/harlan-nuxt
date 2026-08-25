<h1>@harlan-zw/nuxt-wide-events</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Wide Events emits one structured record per request from your Nuxt server routes.

Production writes one flat JSON line. Development prints a richer record with error details.

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

## Why Nuxt Wide Events?

Traditional request logging scatters one request across many disconnected lines. A Wide Event collects that context into one record.

This module drops runtime redaction entirely. You configure every application Field before any code can use it.

The build parses each server file. It rejects unknown Fields, object spreads, computed names, and dynamic objects. So the boundary stays visible to reviewers and to coding agents.

## Features

- 📝 **One record per request:** method, path, status, duration, request ID, and your Fields on a single flat line.
- 🚧 **Build-time Field enforcement:** an unapproved key stops the build, so no secret reaches a log by accident.
- 🪶 **Small production runtime:** no stack formatting, deep redaction, regular expressions, or pretty printing.
- 🎚️ **Levels that stick:** a record keeps the highest level it receives, even when the handler recovers.
- ⚙️ **Background records:** `createWideEvent` covers Queue Jobs, scheduled work, and anything off the request path.
- 🚰 **Drain hook:** send records to D1, Sentry, or your own adapter through one Nitro hook.
- 📉 **Route exclusion and sampling:** the config shape matches evlog, so migration is a rename.

## Installation

```bash
npx nuxi@latest module add @harlan-zw/nuxt-wide-events
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-wide-events
> ```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-wide-events'],

  wideEvents: {
    service: 'shop',
    fields: [
      'cart.itemCount',
      'user.id',
    ],
  },
})
```

## Add Fields

`addWideEventFields` is available in server code.

```ts
export default defineEventHandler((event) => {
  addWideEventFields(event, {
    'cart.itemCount': 2,
    'user.id': 'user_123',
  })

  return { ok: true }
})
```

Each value must be a string, number, boolean, or `null`. Nested objects cannot hide unapproved data.

This code stops the build because `user.email` is not configured:

```ts
addWideEventFields(event, {
  'user.email': user.email,
})
```

Variables and spreads also stop the build:

```ts
addWideEventFields(event, fields)
addWideEventFields(event, { ...fields })
```

## Set the level

`setWideEventLevel` marks a request Wide Event as `debug`, `info`, `warn`, or `error`.

```ts
export default defineEventHandler(async (event) => {
  try {
    return await chargeCard()
  }
  catch {
    setWideEventLevel(event, 'error')
    return { charged: false }
  }
})
```

A record keeps the highest level it receives. If the request handler recovers from an error, the record stays an error. A drain and a sampling rate both see the real level.

## Production output

Default production performs no stack formatting, deep redaction, regular expression matching, or pretty printing.

```json
{ "timestamp": "2026-08-13T04:12:00.000Z", "level": "info", "kind": "request", "service": "shop", "method": "GET", "path": "/api/cart", "status": 200, "durationMs": 1.4, "requestId": "req_123", "cart.itemCount": 2, "user.id": "user_123" }
```

`kind` is `request` for a request record and `background` for a background record.

Production errors include status only. All error strings remain absent because they can contain unapproved data.

Development records include error messages and stacks. Development uses compact terminal blocks with request metadata in the header and configured Fields in a tree.

## Background operations

`createWideEvent` is available in server code for Queue Jobs, scheduled work, and other background operations.

```ts
export default defineTask({
  async run() {
    const wideEvent = createWideEvent({ 'job.id': 'job_123' })
    wideEvent.setLevel('warn')
    return await wideEvent.emit()
  },
})
```

A background record carries `kind: "background"`. It has no `method`, `path`, or `status`, because a background operation has none.

The Nuxt auto-import selects JSON output in production and object output in development. It uses the configured `service`, `console`, `sampling`, and `drain` options. With `drain: true`, `emit()` returns a Promise and waits for background drain adapters. Without a drain, `emit()` remains synchronous.

Use `@harlan-zw/nuxt-wide-events/standalone` when Nuxt auto-imports are unavailable. Inside Nitro this export resolves to the same configured variant as the auto-import, so a deep import never loses `service`, `console`, `sampling`, or `drain`. Outside Nitro it writes production JSON without module configuration.

Set `request: false` to disable request collection. Field enforcement, `createWideEvent`, and `setWideEventLevel` remain available.

Set `enabled: false` to stop all output. Every server import still resolves, so application code needs no change.

## Migrate from evlog

Map `env.service` to `service`. Keep `exclude` and `sampling` unchanged. Do not copy `console: false`: evlog applies it to browser output, while this option controls server output.

For requests, replace `log.set({ section: { value } })` with an approved flat Field:

```ts
addWideEventFields(event, { 'section.value': value })
```

For background operations, replace `createLogger(fields)` with `createWideEvent(fields)`. Replace each `.set(fields)` call with `addWideEventFields(wideEvent, fields)`. Keep `.setLevel()`. If `drain` is enabled, await or return `.emit()`.

For requests, replace `log.setLevel(level)` with `setWideEventLevel(event, level)`.

Set `request: false` for background-only sites. Convert spreads, computed keys, arrays, and nested objects into configured primitive Fields. Keep browser logging and custom error transports in the application.

## Production filtering

The configuration shape matches evlog for direct migration:

```ts
export default defineNuxtConfig({
  wideEvents: {
    exclude: ['/api/_nuxt_icon/**', '/api/_content/**'],
    sampling: {
      rates: { info: 10, warn: 50, debug: 0 },
      keep: [{ duration: 1000 }, { status: 400 }],
    },
  },
})
```

Rates are percentages. A record is kept when it matches one whole keep condition. Every part of one condition must match, and the conditions are tried in order. So `{ duration: 1000, status: 500 }` keeps a slow server error, while `[{ duration: 1000 }, { status: 500 }]` keeps either one.

Every level rate applies to every Wide Event. A background record has no status, so a status condition never keeps one.

The module compiles route patterns during the build. A pattern that ends with `/**` also matches the bare prefix, which is how Nitro matches routes. Default production uses a separate plugin without filtering code.

## Drain records

Use the Nitro hook when D1, Sentry, or another adapter owns the record:

```ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('wide-events:emit', async (record) => {
    await sendRecord(record)
  })
})
```

Set `drain: true` to enable this hook. `console` then defaults to `false`, because the hook owns the record. Set `console: true` to keep stdout output as well.
Request drains use `event.waitUntil()`. Background `emit()` waits for every hook adapter and surfaces adapter failures.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Emit Wide Events. `false` keeps Field enforcement and server imports. |
| `request` | `true` | Collect one Wide Event for each request. |
| `fields` | `[]` | Allow application Fields. |
| `service` | none | Add a service name. |
| `exclude` | `[]` | Exclude routes that match a glob pattern. |
| `sampling` | none | Set rates and keep conditions for production. |
| `console` | `true`, or `false` with a drain | Write records to stdout. |
| `drain` | `false` | Call the `wide-events:emit` hook for request and background records. |

## Benchmarks

Run the production benchmarks on the target deployment runtime:

```bash
pnpm test:bench
```

The suite compares lifecycle cost and serialization against raw JSON, Pino, and evlog.
It also includes 0x flamegraphs and real Nitro HTTP fixtures for this module and evlog.

See the [core results](./bench/RESULTS.md), [Nitro HTTP results](./bench/http/RESULTS.md), and [CPU profile](./bench/PROFILE.md).

```bash
node bench/http/run.mjs
npx 0x --tree-debug bench/profile.mjs wide
```

The Cloudflare fixture builds with the Workers preset, passes a Wrangler deploy dry run, and serves a request through local workerd.

## Scope

The first version supports Nuxt server requests, flat primitive Fields, route exclusion, sampling, stdout, and a Nitro hook.

It excludes browser logging, transports, audit logs, and production error presentation.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-wide-events/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-wide-events/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-wide-events

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-wide-events.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-wide-events

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-wide-events/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
