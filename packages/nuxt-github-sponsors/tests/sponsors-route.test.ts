import { afterEach, expect, it, vi } from 'vitest'
import sponsors from '../src/runtime/server/api/sponsors.get'

vi.mock('nuxt/server', () => ({
  defineEventHandler: (handler: unknown) => handler,
  // Nuxt 4.6's portable server API returns shared config, even with an event.
  useRuntimeConfig: () => ({
    githubSponsors: { token: '', tokenEnv: 'SPONSORS_ROUTE_TEST_ALIAS', login: 'harlan-zw', tiers: [], overrides: {} },
  }),
}))

vi.mock('#nuxt-github-sponsors/nitro', () => ({
  defineCachedFunction: (handler: unknown) => handler,
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('uses the request-bound Worker secret when the process alias is unset', async () => {
  vi.stubEnv('SPONSORS_ROUTE_TEST_ALIAS', undefined)
  vi.stubEnv('NUXT_GITHUB_SPONSORS_TOKEN', undefined)
  const token = 'inertWorkerSponsorsFixture'
  const github = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    data: { user: { sponsorshipsAsMaintainer: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
  }))
  vi.stubGlobal('fetch', github)
  const response = await sponsors({
    req: new Request('https://worker.example/api/sponsors'),
    url: new URL('https://worker.example/api/sponsors'),
    res: { headers: new Headers() },
    context: { cloudflare: { env: { NUXT_GITHUB_SPONSORS_TOKEN: token } } },
  })

  expect(github).toHaveBeenCalledWith('https://api.github.com/graphql', expect.objectContaining({
    headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
  }))
  expect(response).toMatchObject({ _tag: 'available', sponsors: [] })
  expect(JSON.stringify(response).includes(token)).toBe(false)

  const withoutSecret = await sponsors({
    req: new Request('https://worker.example/api/sponsors'),
    url: new URL('https://worker.example/api/sponsors'),
    res: { headers: new Headers() },
    context: { cloudflare: { env: {} } },
  })
  expect(withoutSecret).toMatchObject({ _tag: 'unavailable', reason: 'not-configured' })
  expect(github).toHaveBeenCalledTimes(1)
})
