<h1>@harlan-zw/nuxt-wide-events</h1>

Minimal Wide Events for Nuxt server routes.

Production emits one flat JSON record per request. Development prints richer records with error details.

## Why

Traditional request logging creates many disconnected lines. A Wide Event collects request context into one record.

This module removes runtime redaction. You configure every application Field before code can use it.

The build parses each server file. It rejects unknown Fields, object spreads, computed names, and dynamic objects.

## Install

```bash
pnpm add @harlan-zw/nuxt-wide-events
```

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

This constraint keeps the Field boundary visible to reviewers and coding agents.

## Production Output

Default production performs no stack formatting, deep redaction, regular expression matching, or pretty printing.

```json
{ "timestamp": "2026-08-13T04:12:00.000Z", "level": "info", "service": "shop", "method": "GET", "path": "/api/cart", "status": 200, "durationMs": 1.4, "requestId": "req_123", "cart.itemCount": 2, "user.id": "user_123" }
```

Production errors include status only. All error strings remain absent because they can contain unapproved data.

Development records include error messages and stacks. Development uses compact terminal blocks with request metadata in the header and configured Fields in a tree.

## Background Operations

`createWideEvent` is available in server code for Queue Jobs, scheduled work, and other background operations.

```ts
export default defineTask({
  async run() {
    const wideEvent = createWideEvent({ 'job.id': 'job_123' })
    wideEvent.setLevel('info')
    return await wideEvent.emit()
  },
})
```

The Nuxt auto-import selects JSON output in production and object output in development. It uses the configured `service`, `console`, and `drain` options. With `drain: true`, `emit()` returns a Promise and waits for background drain adapters. Without a drain, `emit()` remains synchronous.

Use `@harlan-zw/nuxt-wide-events/standalone` when Nuxt auto-imports are unavailable. This package export always uses production JSON output without module configuration.

Set `request: false` to disable request collection. Field enforcement and `createWideEvent` remain available.

## Migrate from evlog

Map `env.service` to `service`. Keep `exclude` and `sampling` unchanged. Do not copy `console: false`: evlog applies it to browser output, while this option controls server output.

For requests, replace `log.set({ section: { value } })` with an approved flat Field:

```ts
addWideEventFields(event, { 'section.value': value })
```

For background operations, replace `createLogger(fields)` with `createWideEvent(fields)`. Replace each `.set(fields)` call with `addWideEventFields(wideEvent, fields)`. Keep `.setLevel()`. If `drain` is enabled, await or return `.emit()`.

Set `request: false` for background-only sites. Convert spreads, computed keys, arrays, and nested objects into configured primitive Fields. Keep browser logging and custom error transports in the application.

## Production Filtering

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

Rates are percentages. Keep conditions use `>=` and OR logic. Request Wide Events use `info` and `error` rates. Standalone Wide Events also use `debug` and `warn` rates.

The module compiles route patterns during the build. Default production uses a separate plugin without filtering code.

## Drain Records

Use the Nitro hook when D1, Sentry, or another adapter owns the record:

```ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('wide-events:emit', async (record) => {
    await sendRecord(record)
  })
})
```

Set `drain: true` to enable this hook. Set `console: false` when the hook owns output.
Request drains use `event.waitUntil()`. Background `emit()` waits for every hook adapter and surfaces adapter failures.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Register request collection and output. |
| `request` | `true` | Collect one Wide Event for each request. |
| `fields` | `[]` | Allow application Fields. |
| `service` | none | Add a service name. |
| `exclude` | `[]` | Exclude routes that match a glob pattern. |
| `sampling` | none | Set rates and keep conditions for production. |
| `console` | `true` | Write records to stdout. |
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

## License

MIT
