# `@harlan-zw/nuxt-dx`

Experimental, development-only diagnostics for Nuxt.

The initial feature is a client error overlay that collects Vue warnings, Vue errors, console errors, uncaught errors, and unhandled rejections. It can copy a concise report with route and source-file context for an agent handoff.

The module is a strict production no-op. It only registers its client plugin when Nuxt runs in development mode.

```bash
pnpm add -D @harlan-zw/nuxt-dx
```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-dx'],
  nuxtDx: {
    position: 'bottom-right',
  },
})
```

APIs may change before the first release.
