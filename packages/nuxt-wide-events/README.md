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

Production performs no stack formatting, deep redaction, regular expression matching, or pretty printing.

```json
{ "timestamp": "2026-08-13T04:12:00.000Z", "level": "info", "service": "shop", "method": "GET", "path": "/api/cart", "status": 200, "durationMs": 1.4, "requestId": "req_123", "cart.itemCount": 2, "user.id": "user_123" }
```

Errors include status and error class. Their messages and stacks remain absent because they can contain unapproved data.

Development records include error messages and stacks. Development uses object output for easier inspection.

## Drain Records

Use the Nitro hook when stdout is not the final destination:

```ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('wide-events:emit', async (record) => {
    await sendRecord(record)
  })
})
```

Set `console: false` when the hook owns output.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Register request collection and output. |
| `fields` | `[]` | Allow application Fields. |
| `service` | none | Add a service name. |
| `console` | `true` | Write records to stdout. |

## Benchmarks

Run the production benchmarks on the target deployment runtime:

```bash
pnpm test:bench
```

The suite compares lifecycle cost and serialization against raw JSON, Pino, and evlog.

## Scope

The first version supports Nuxt server requests, flat primitive Fields, stdout, and a Nitro hook.

It excludes browser logging, transports, sampling, route matching, audit logs, and error presentation.

## License

MIT
