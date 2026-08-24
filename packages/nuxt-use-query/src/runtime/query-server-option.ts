export interface QueryServerDeadline {
  /** Maximum time that server rendering waits for this query, in milliseconds. */
  deadline: number
}

export type QueryServerOption = boolean | QueryServerDeadline

const QUERY_SSR_DEADLINE = Symbol('nuxt-use-query-ssr-deadline')

type QuerySsrDeadlineError = DOMException & {
  [QUERY_SSR_DEADLINE]: QueryServerDeadline
}

interface QuerySsrDeferredValue {
  readonly [QUERY_SSR_DEADLINE]: QueryServerDeadline
  readonly error: QuerySsrDeadlineError
}

const QUERY_SSR_DEFERRED_PAYLOAD_TAG = 'nuxt-use-query:ssr-deferred'

interface QuerySsrDeferredPayload {
  readonly _tag: typeof QUERY_SSR_DEFERRED_PAYLOAD_TAG
}

export function resolveQueryServerOption(option: QueryServerOption | undefined): {
  deadline?: number
  server: boolean
} {
  if (option === false)
    return { server: false }
  if (option == null || option === true)
    return { server: true }
  if (!Number.isFinite(option.deadline) || option.deadline <= 0)
    throw new TypeError('Query server deadline must be a positive number.')
  return { deadline: option.deadline, server: true }
}

export async function runWithQuerySsrDeadline<T>(options: {
  deadline: number
  onDeferred: (error: QuerySsrDeadlineError) => void
  run: (signal: AbortSignal) => Promise<T>
  signal: AbortSignal
}): Promise<QuerySsrDeferredValue | T> {
  const controller = new AbortController()
  const abortFromOwner = () => controller.abort(options.signal.reason)
  if (options.signal.aborted)
    abortFromOwner()
  else
    options.signal.addEventListener('abort', abortFromOwner, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<QuerySsrDeferredValue>((resolve) => {
    timeout = setTimeout(() => {
      const error = createQuerySsrDeadlineError(options.deadline)
      options.onDeferred(error)
      resolve({
        [QUERY_SSR_DEADLINE]: { deadline: options.deadline },
        error,
      })
      controller.abort(error)
    }, options.deadline)
  })

  try {
    return await Promise.race([options.run(controller.signal), deadline])
  }
  finally {
    if (timeout != null)
      clearTimeout(timeout)
    options.signal.removeEventListener('abort', abortFromOwner)
  }
}

export function getQuerySsrDeadline(error: unknown): number | undefined {
  let current = error
  for (let depth = 0; depth < 3; depth++) {
    if (current && typeof current === 'object' && QUERY_SSR_DEADLINE in current)
      return (current as QuerySsrDeadlineError)[QUERY_SSR_DEADLINE].deadline
    current = current && typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined
  }
  return undefined
}

export function isQuerySsrDeferredValue(value: unknown): value is QuerySsrDeferredValue {
  return value != null && typeof value === 'object' && QUERY_SSR_DEADLINE in value && 'error' in value
}

export function createQuerySsrDeferredPayload(): QuerySsrDeferredPayload {
  return { _tag: QUERY_SSR_DEFERRED_PAYLOAD_TAG }
}

export function isQuerySsrDeferredPayload(value: unknown): value is QuerySsrDeferredPayload {
  return value != null
    && typeof value === 'object'
    && '_tag' in value
    && value._tag === QUERY_SSR_DEFERRED_PAYLOAD_TAG
}

function createQuerySsrDeadlineError(deadline: number): QuerySsrDeadlineError {
  const error = new DOMException(`Query exceeded its ${deadline}ms server deadline.`, 'AbortError') as QuerySsrDeadlineError
  Object.defineProperty(error, QUERY_SSR_DEADLINE, {
    value: { deadline },
  })
  return error
}
