import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The contract against a real Nitro server.
 *
 * Every defect three review passes found lived here rather than in the pure
 * functions: header precedence between the floor and a route rule, which hook
 * sees what, and what the route-rule handler leaves on the response. Unit tests
 * over the decision functions could not have caught any of them.
 */
const entry = fileURLToPath(new URL('./fixtures/cache-contract/.output/server/index.mjs', import.meta.url))
const PORT = 3987
const base = `http://127.0.0.1:${PORT}`

let server: ChildProcess

async function waitForBoot(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(`${base}/api/json`)
      return
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw new Error('fixture server did not start')
}

function doc(path: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    headers: { 'accept': 'text/html', 'sec-fetch-dest': 'document', ...headers },
  })
}

beforeAll(async () => {
  server = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT) },
    stdio: 'ignore',
  })
  await waitForBoot()
}, 60_000)

afterAll(() => {
  server?.kill()
})

describe('cache contract, real server', () => {
  // The bug this branch exists to fix. A route rule setting only
  // `cache-control` must survive to the wire, and nothing may leave a
  // higher-precedence `no-store` behind it.
  it('lets a document route rule through untouched', async () => {
    const res = await doc('/cached')

    expect(res.headers.get('cache-control')).toBe('public, s-maxage=300')
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBeNull()
  })

  it('lowers a rule that outlives the published guarantee', async () => {
    const res = await doc('/too-long')

    expect(res.headers.get('cache-control')).toBe('public, s-maxage=600')
  })

  // The regression that made this worse than doing nothing: the document
  // policy applied to every response, so an API route's own header was
  // rewritten to no-store.
  it('never touches a response that is not a document', async () => {
    const res = await fetch(`${base}/api/json`)

    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('closes a document nobody described', async () => {
    const res = await doc('/')

    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
  })

  it('refuses a credentialed request however the rule reads', async () => {
    const res = await doc('/cached', { cookie: 'session=abc' })

    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('refuses a bearer token, which carries no cookie', async () => {
    const res = await doc('/cached', { authorization: 'Bearer abc' })

    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  // A shared cache does not key on Cookie, so honouring this Vary means not
  // storing the response.
  it('refuses a response varying on something the cache cannot key on', async () => {
    const res = await doc('/varies')

    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  // Nitro's error renderer calls `send()` directly, which marks the event
  // handled, so `beforeResponse` never runs on an error. Nitro then writes its
  // own `no-cache`, which is why this asserts the safety property rather than
  // an exact string: whatever an unmatched path returns, it must never be
  // something a shared cache will hand to the next person.
  it('never makes an unmatched path shared-cacheable', async () => {
    const res = await fetch(`${base}/api/nope-does-not-exist`)
    const policy = res.headers.get('cache-control') ?? ''

    expect(policy).not.toMatch(/s-maxage=[1-9]/)
    expect(policy).not.toMatch(/public/)
  })
})
