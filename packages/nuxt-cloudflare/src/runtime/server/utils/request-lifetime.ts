/** The Worker context Nitro's Cloudflare entry passes to `localFetch`. */
export interface LocalFetchInit {
  context?: {
    waitUntil?: (promise: Promise<unknown>) => void
  }
}

/** Nitro 2's in-process fetch, `nitroApp.localFetch`. */
export type LocalFetch = (input: string, init?: LocalFetchInit) => Promise<Response>

export interface WorkerRequest extends Request {
  waitUntil?: (promise: Promise<unknown>) => void
}

/** Nitro 3's in-process fetch. The Cloudflare entry attaches `waitUntil` to the request. */
export type NativeFetch = (request: WorkerRequest) => Response | Promise<Response>

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

/**
 * Wraps Nitro 3's `fetch` so each Worker request stays alive until its own
 * response settles.
 *
 * `serverFetch` and `$fetch('/api/…')` dispatch a new Request without
 * `waitUntil`. Such a sub-request takes the `waitUntil` of the request that
 * makes it, read through `enclosingRequest`. A cached handler in the
 * sub-request then registers its resolution, refresh and cache write with the
 * Worker, and the Worker stays alive until the sub-request answers, even when
 * its caller stops waiting.
 */
export function keepNativeRequestAlive(
  fetch: NativeFetch,
  enclosingRequest: () => WorkerRequest | undefined = () => undefined,
): NativeFetch {
  return (request) => {
    if (!request.waitUntil) {
      const waitUntil = enclosingRequest()?.waitUntil
      if (waitUntil)
        request.waitUntil = waitUntil
    }
    const response = fetch(request)
    request.waitUntil?.(Promise.resolve(response).then(() => undefined, () => undefined))
    return response
  }
}
