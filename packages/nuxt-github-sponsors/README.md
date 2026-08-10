# `@harlan-zw/nuxt-github-sponsors`

Experimental GitHub Sponsors data for Nuxt sites.

The module registers a public route and `useGitHubSponsors`. The server core fetches all active sponsorship pages, parses GitHub responses, filters private sponsors, projects a minimal public DTO, applies explicit profile overrides, and assigns configurable tiers. Only successful upstream results receive the one-day SWR cache.

```bash
pnpm add @harlan-zw/nuxt-github-sponsors
```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-github-sponsors'],
  githubSponsors: {
    login: 'your-github-login',
    mode: 'runtime', // or 'prerender'
    tiers: [
      { key: 'partner', minimumMonthlyDollars: 50 },
      { key: 'supporter', minimumMonthlyDollars: 25 },
    ],
  },
})
```

Set `NUXT_GITHUB_SPONSORS_TOKEN` at runtime. The route returns an explicit `unavailable` state with reason `not-configured` when no token exists and a `502` response when GitHub cannot be refreshed. No secret is logged.

The package intentionally has no sponsor UI. Each site keeps control of its visual identity and calls `useGitHubSponsors()` for a typed response.

APIs may change before the first release.
