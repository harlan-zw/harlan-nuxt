/** The Worker context Nitro's Cloudflare entry passes to `localFetch`. */
export interface LocalFetchInit {
  context?: {
    waitUntil?: (promise: Promise<unknown>) => void
  }
}

/** Nitro 2's in-process fetch, `nitroApp.localFetch`. */
export type LocalFetch = (input: string, init?: LocalFetchInit) => Promise<Response>

/**
 * Wraps Nitro's `localFetch` so each Worker request stays alive until its own
 * response settles.
 *
 * Nitro's cached functions and Nuxt Content share one in-flight promise per key
 * across every request in an isolate. On Workers a promise can only settle in
 * the request that created it. When a visitor leaves, Cloudflare cancels that
 * request, the shared promise can never settle, and every later request for the
 * key fails. Registering the response with `waitUntil` keeps the creating
 * request alive for up to 30 seconds after its client disconnects.
 *
 * A fetch without a Worker context, such as an internal `$fetch` outside a
 * request, passes through unchanged.
 */
export function keepRequestAlive(localFetch: LocalFetch): LocalFetch {
  return (input, init) => {
    const response = Promise.resolve(localFetch(input, init))
    // The caller receives any rejection; this copy only extends the lifetime.
    init?.context?.waitUntil?.(response.then(() => undefined, () => undefined))
    return response
  }
}
