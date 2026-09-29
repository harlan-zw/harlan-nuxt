<h1>@harlan-zw/nuxt-wide-events</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Wide Events writes one structured record for each request to your Nuxt server routes.

Production writes one flat JSON line. Development prints a richer record with error details.

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

Most request logging spreads one request across many lines. A wide event puts that request in one record.

This module has no runtime redaction. You list every application field in config before code can use it.

The build parses each server file. It rejects unknown fields, object spreads, computed names, and dynamic objects. So reviewers and coding agents can see every field a record can carry.

## Features

- 📝 **One record per request:** you debug a request from one flat line, not a trail of scattered log lines.
- 🚧 **Build-time field enforcement:** an unapproved key stops the build, so no secret reaches a log by accident.
- 🪶 **Small production runtime:** logging adds little cost per request, because production skips stack formatting and pretty printing.
- 🎚️ **Levels that stick:** a handler that recovers from an error still logs an error, so sampling and drains see the real level.
- ⚙️ **Background records:** Queue Jobs, scheduled work, and other background operations get the same single record as a request.
- 🚰 **Drain hook:** you send records to D1, Sentry, or your own adapter from one Nitro hook, not from each route.
- 📉 **Route exclusion and sampling:** noisy routes stop flooding your logs, and your evlog filter config works unchanged.

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

`setWideEventLevel` marks a request wide event as `debug`, `info`, `warn`, or `error`.

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

A record keeps the highest level it receives. If the request handler recovers from an error, the record stays an error. Drains and sampling both see the real level.

`getActiveWideEventRequestId(event)` returns the request ID while the wide event collects data. Use it to tie an application logger, Sentry, or another request-scoped module to the same request. It returns `undefined` before collection starts and after emission.

## Production output

Default production output skips stack formatting, deep redaction, regular expression matching, and pretty printing.

```json
{ "timestamp": "2026-08-13T04:12:00.000Z", "level": "info", "kind": "request", "service": "shop", "method": "GET", "path": "/api/cart", "status": 200, "durationMs": 1.4, "requestId": "req_123", "cart.itemCount": 2, "user.id": "user_123" }
```

`kind` is `request` for a request record and `background` for a background record.

In production, an error record carries the status only. It drops every error string, because an error string can hold unapproved data.

In development, records include error messages and stacks. The terminal shows each record as a compact block, with request metadata in the header and configured fields in a tree.

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

The Nuxt auto-import selects JSON output in production and object output in development. It uses the configured `service`, `console`, `sampling`, and `drain` options. With `drain: true`, `emit()` returns a Promise and waits for background drain adapters. Without a drain, `emit()` stays synchronous.

If Nuxt auto-imports are unavailable, import from `@harlan-zw/nuxt-wide-events/standalone`. Inside Nitro, this export resolves to the same configured variant as the auto-import. So a deep import never loses `service`, `console`, `sampling`, or `drain`. Outside Nitro, it writes production JSON with no module configuration.

To turn off request collection, set `request: false`. Field enforcement, `createWideEvent`, and `setWideEventLevel` still work.

To stop all output, set `enabled: false`. Every server import still resolves, so your application code needs no change.

## Migrate from evlog

Map `env.service` to `service`. Keep `exclude` and `sampling` unchanged. Do not copy `console: false`. In evlog it controls browser output; here it controls server output.

For requests, replace `log.set({ section: { value } })` with an approved flat field:

```ts
addWideEventFields(event, { 'section.value': value })
```

For background operations, replace `createLogger(fields)` with `createWideEvent(fields)`. Replace each `.set(fields)` call with `addWideEventFields(wideEvent, fields)`. Keep `.setLevel()`. If `drain` is enabled, await or return `.emit()`.

For requests, replace `log.setLevel(level)` with `setWideEventLevel(event, level)`.

If a site only logs background operations, set `request: false`. Convert spreads, computed keys, arrays, and nested objects into configured primitive fields. Keep browser logging and custom error transports in the application.

## Production filtering

The config shape matches evlog, so you can copy it across:

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

Rates are percentages. The module keeps a record that matches one keep condition in full. Every part of a condition must match. The module tries the conditions in order. So `{ duration: 1000, status: 500 }` keeps a slow server error, and `[{ duration: 1000 }, { status: 500 }]` keeps either one.

Level rates apply to request and background records alike. A background record has no status, so a status condition never keeps one.

The build compiles route patterns. A pattern that ends with `/**` also matches the bare prefix, the same as Nitro. If you set no `exclude` or `sampling`, production uses a separate plugin with no filtering code.

## Drain records

If D1, Sentry, or another adapter owns the record, use the Nitro hook:

```ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('wide-events:emit', async (record) => {
    await sendRecord(record)
  })
})
```

To turn on this hook, set `drain: true`. `console` then defaults to `false`, because the hook owns the record. To keep stdout output too, set `console: true`.
Request drains use `event.waitUntil()`. Background `emit()` waits for every hook adapter and rejects if an adapter fails.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Emit wide events. `false` keeps field enforcement and server imports. |
| `request` | `true` | Collect one wide event for each request. |
| `fields` | `[]` | Allow application fields. |
| `service` | none | Add a service name. |
| `exclude` | `[]` | Exclude routes that match a glob pattern. |
| `sampling` | none | Set rates and keep conditions for production. |
| `console` | `true`, or `false` with a drain | Write records to stdout. |
| `drain` | `false` | Call the `wide-events:emit` hook for request and background records. |

## Benchmarks

Run the production benchmarks on the runtime you deploy to:

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

This module covers Nuxt server requests, background operations, flat primitive fields, route exclusion, sampling, stdout, and a Nitro hook.

It does not cover browser logging, transports, audit logs, or production error presentation.

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
