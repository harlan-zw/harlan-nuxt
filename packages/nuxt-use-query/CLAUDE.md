# nuxt-use-query

TanStack-Query-shaped wrapper over Nuxt's `useFetch` / `useAsyncData`. Built on Nuxt primitives (`refreshNuxtData`, `clearNuxtData`, `_asyncData`); cache state lives on the Nuxt app instance for SSR safety.

## Consumers

Changes here ripple into:

- `~/pkg/gscdump`
- `~/sites/gscdump.com`
- `~/sites/nuxtseo.com`

When touching public API (auto-imports, subpath exports, RPC operation shapes, cache helpers), check these consumers before shipping.
