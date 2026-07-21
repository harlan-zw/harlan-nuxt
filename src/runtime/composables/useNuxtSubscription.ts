import type { MaybeRefOrGetter, Ref } from 'vue'
import { effectScope, getCurrentScope, onScopeDispose, ref, toValue, watch } from 'vue'
import { onNuxtReady, useNuxtApp } from '#app'

// `useNuxtSubscription` — a transport-agnostic bridge from a realtime message
// stream into the query cache. It deliberately does NOT own a connection:
// the caller injects the transport via `source`, and the bridge turns each
// message into explicit, awaitable cache effects.
//
// Why a bridge and not a socket: the connection (auth, reconnect, channel
// multiplexing) is infrastructure that already lives in the host app
// (`nuxt-cf-jobs`, a vendor SDK, raw `useWebSocket`, …). Owning it here would
// compete with that. What every consumer re-invents instead is the
// "message -> data freshness" wiring; that is the seam this standardises.
//
// `push` and `resync` share one FIFO effect queue. A durable transport can await
// the returned Promise before advancing its cursor/ACK; a required effect
// rejection is both reported through `error`/`onError` and propagated back to
// the source.

export type NuxtSubscriptionStatus = 'idle' | 'connecting' | 'active' | 'error'

/**
 * Parse an untrusted socket frame into a trusted `TMessage` once, at the
 * boundary, before `onMessage` ever sees it. Either a plain function, or any
 * object exposing a synchronous `parse(raw)` that throws on invalid input
 * (a Zod schema). The thrown error is routed to `onError` and rejects the
 * corresponding push.
 */
export type NuxtSubscriptionParser<TMessage>
  = | ((raw: unknown) => TMessage)
    | { parse: (raw: unknown) => TMessage }

/** The part of the source context the pure controller builds. */
export type NuxtSubscriptionResyncArgs<TResync> = [TResync] extends [void]
  ? []
  : [request: TResync]

export interface SubscriptionContextBase<TResync = void> {
  /** Report a source-side failure through the ordered effect channel. */
  fail: (error: unknown) => Promise<void>
  /**
   * Deliver a raw frame and resolve after its effect settles. Rejects with the
   * effect error, or `AbortError` if this activation is stale before execution.
   */
  push: (raw: unknown) => Promise<void>
  /** Aborted when the subscription is disabled or its scope disposes. */
  signal: AbortSignal
  /**
   * Run an explicit resynchronization effect in the same FIFO as messages.
   * It has the same rejection/teardown semantics as `push`.
   */
  resync: (...args: NuxtSubscriptionResyncArgs<TResync>) => Promise<void>
}

/** Handed to `source` so it can feed the bridge without importing internals. */
export type NuxtSubscriptionSource<TResync = void> = SubscriptionContextBase<TResync>

export interface UseNuxtSubscriptionOptions<TMessage, TResync = void> {
  /**
   * Establish the message stream. Runs client-only, after hydration. Wire
   * teardown to `ctx.signal` and/or return a cleanup function. May be async;
   * if `enabled` flips false (or the scope disposes) before it resolves, the
   * resolved cleanup is invoked and discarded — no leak, no double-connect.
   *
   * It runs inside its own effect scope, so a source that calls Vue composables
   * (`useWebSocket`, a channel composable) or sets up `watch`ers has their
   * `onScopeDispose` / watch cleanup torn down on teardown automatically — even
   * though it runs after setup, outside the calling component's scope. Create
   * those composables SYNCHRONOUSLY (before any `await`): only the synchronous
   * portion of an async source is captured by the scope.
   */
  source: (ctx: NuxtSubscriptionSource<TResync>) => void | (() => void) | Promise<void | (() => void)>
  /** Map a parsed message to cache operations. Explicit by design. */
  onMessage: (message: TMessage) => void | Promise<void>
  /** Parse-at-boundary for untrusted frames. Omit to pass frames through as-is. */
  schema?: NuxtSubscriptionParser<TMessage>
  /** Explicit gap/recovery effect. The source must await `ctx.resync(request)`. */
  onResync?: (request: TResync) => void | Promise<void>
  /** Per-message, parse, resync, and establishment failures. No silent swallow. */
  onError?: (error: unknown) => void
  /** Gate the subscription. Default `true`. */
  enabled?: MaybeRefOrGetter<boolean>
}

export interface NuxtSubscription {
  /**
   * Bridge ESTABLISHMENT state, NOT live socket health (the bridge never sees
   * the transport, only its messages): `idle` before/after, `connecting` while
   * an async `source` resolves, `active` once established, `error` if `source`
   * itself fails. Per-message / parse / resync failures surface through
   * `error` + `onError`, not `status` (a parse blip shouldn't read as a dropped
   * connection); watch `error` if you need those.
   */
  status: Ref<NuxtSubscriptionStatus>
  /** Most recent error from `source` / parse / `onMessage` / `onResync`. */
  error: Ref<unknown>
}

type SourceCleanup = void | (() => void)

export interface SubscriptionControllerDeps<TResync = void> {
  source: (ctx: SubscriptionContextBase<TResync>) => SourceCleanup | Promise<SourceCleanup>
  /** Parse + deliver in Nuxt context. Rejections are reported and propagated. */
  handleMessage: (raw: unknown) => void | Promise<void>
  /** Run an explicit recovery effect in Nuxt context. */
  handleResync: (request: TResync) => void | Promise<void>
  handleError: (error: unknown) => void
  setStatus: (status: NuxtSubscriptionStatus) => void
}

/**
 * Pure (no Vue, no Nuxt) state machine for establish/teardown. Isolated so the
 * async-establish + `enabled`-flip race is unit-testable without a runtime.
 *
 * The race it closes: an async `source` can resolve its cleanup *after* the
 * subscription was already disabled. A monotonic `epoch` stamps each activate;
 * a cleanup that comes back from a stale epoch is invoked-and-discarded rather
 * than stored. Work queued against a stale epoch rejects with an `AbortError`,
 * so a transport can never mistake a dropped effect for an ACK.
 */
export function createSubscriptionController<TResync = void>(deps: SubscriptionControllerDeps<TResync>) {
  let epoch = 0
  let active = false
  let controller: AbortController | undefined
  let cleanup: (() => void) | undefined

  function runCleanup(fn: (() => void) | undefined): void {
    if (!fn)
      return
    try {
      fn()
    }
    catch (error) {
      deps.handleError(error)
    }
  }

  function fail(error: unknown, myEpoch: number): void {
    if (epoch !== myEpoch)
      return
    active = false
    // Abort so a source that wired teardown to `ctx.signal` still tears down.
    controller?.abort()
    controller = undefined
    deps.handleError(error)
    deps.setStatus('error')
  }

  function activate(): void {
    if (active)
      return
    active = true
    const myEpoch = ++epoch
    const ac = new AbortController()
    controller = ac
    deps.setStatus('connecting')

    // A frame / resync only counts while THIS activation owns the bridge. Each
    // activation gets its own tail so stale work can never block a later retry.
    const isCurrent = (): boolean => active && epoch === myEpoch && !ac.signal.aborted
    let effectTail = Promise.resolve()

    function enqueue(effect: () => void | Promise<void>): Promise<void> {
      if (!isCurrent())
        return Promise.reject(subscriptionAbortError())
      const task = effectTail.then(async () => {
        // It may have become stale while waiting behind an earlier effect.
        if (!isCurrent())
          throw subscriptionAbortError()
        await effect()
      })
      const reported = task.catch((error) => {
        // Teardown is expected control flow. It still rejects the caller's
        // Promise, but should not turn a clean disable/unmount into an error UI.
        if (!isAbortError(error))
          deps.handleError(error)
        throw error
      })
      // Recovery tail: an individual rejection reaches its caller but does not
      // permanently poison delivery of later frames.
      effectTail = reported.catch(() => {
        // The caller owns the reported rejection; only the private queue tail
        // recovers so one failed effect cannot poison later delivery.
        return undefined
      })
      return reported
    }

    const ctx: SubscriptionContextBase<TResync> = {
      fail: error => enqueue(() => Promise.reject(error)),
      signal: ac.signal,
      push: raw => enqueue(() => deps.handleMessage(raw)),
      resync: ((...args: NuxtSubscriptionResyncArgs<TResync>) => {
        const request = (args as unknown as [TResync])[0]
        return enqueue(() => deps.handleResync(request))
      }) as SubscriptionContextBase<TResync>['resync'],
    }

    let result: SourceCleanup | Promise<SourceCleanup>
    try {
      result = deps.source(ctx)
    }
    catch (error) {
      fail(error, myEpoch)
      return
    }

    if (isPromiseLike(result)) {
      result.then(
        (resolved) => {
          const fn = typeof resolved === 'function' ? resolved : undefined
          // Resolved into a stale epoch: the subscription was disabled/disposed
          // mid-connect. Tear the just-established connection straight back down.
          if (epoch !== myEpoch) {
            runCleanup(fn)
            return
          }
          cleanup = fn
          deps.setStatus('active')
        },
        error => fail(error, myEpoch),
      )
    }
    else {
      cleanup = typeof result === 'function' ? result : undefined
      deps.setStatus('active')
    }
  }

  function deactivate(): void {
    if (!active)
      return
    active = false
    // Bump so any in-flight async establish resolves into a stale epoch.
    epoch++
    controller?.abort()
    controller = undefined
    const fn = cleanup
    cleanup = undefined
    runCleanup(fn)
    deps.setStatus('idle')
  }

  return { activate, deactivate }
}

class SubscriptionEpochAbortError extends Error {
  constructor() {
    super('Subscription activation is no longer active.')
    this.name = 'AbortError'
  }
}

function subscriptionAbortError(): Error {
  return new SubscriptionEpochAbortError()
}

function isAbortError(error: unknown): boolean {
  return error instanceof SubscriptionEpochAbortError
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as PromiseLike<T>).then === 'function'
}

function composeCleanup(inner: SourceCleanup, stopScope: () => void): () => void {
  return () => {
    try {
      if (typeof inner === 'function')
        inner()
    }
    finally {
      // A throwing transport cleanup is reported by the controller, but it
      // must never strand the detached source scope (and its watchers/socket).
      stopScope()
    }
  }
}

/**
 * Wrap a user `source` so it runs inside a detached effect scope. Any composable
 * or watcher it creates registers on that scope and is disposed when the
 * subscription tears down — the source runs post-hydration, outside the calling
 * component's scope, where `onScopeDispose` would otherwise be a no-op.
 */
// eslint-disable-next-line harlanzw/vue-require-composable-prefix -- factory that wraps a source in a scope, not a composable
function hostSourceInScope<TMessage, TResync>(
  source: UseNuxtSubscriptionOptions<TMessage, TResync>['source'],
): (ctx: SubscriptionContextBase<TResync>) => SourceCleanup | Promise<SourceCleanup> {
  return (base) => {
    const scope = effectScope(true)
    const stopScope = (): void => void scope.stop()
    let result: SourceCleanup | Promise<SourceCleanup>
    try {
      result = scope.run(() => source(base)) as SourceCleanup | Promise<SourceCleanup>
    }
    catch (error) {
      stopScope()
      throw error
    }
    if (isPromiseLike(result)) {
      return result.then(
        inner => composeCleanup(inner, stopScope),
        (error) => {
          stopScope()
          throw error
        },
      )
    }
    return composeCleanup(result, stopScope)
  }
}

function resolveParser<TMessage>(schema?: NuxtSubscriptionParser<TMessage>): (raw: unknown) => TMessage {
  if (!schema)
    return raw => raw as TMessage
  if (typeof schema === 'function')
    return schema
  return raw => schema.parse(raw)
}

export function useNuxtSubscription<TMessage = unknown, TResync = void>(
  options: UseNuxtSubscriptionOptions<TMessage, TResync>,
): NuxtSubscription {
  const status = ref<NuxtSubscriptionStatus>('idle')
  const error = ref<unknown>(undefined)

  // Realtime is client-only. On the server we hand back inert refs so callers
  // can destructure unconditionally; `source` never runs.
  if (import.meta.server)
    return { status, error }

  const nuxtApp = useNuxtApp()
  const parse = resolveParser(options.schema)

  // Socket frames arrive in microtasks long after setup, so run consumer
  // callbacks through `runWithContext` — same fix `useNuxtRpc` uses — so the
  // global cache helpers (and `useToast` etc.) resolve their Nuxt context.
  const handleError = (err: unknown): void => {
    error.value = err
    if (options.onError) {
      try {
        const observed = nuxtApp.runWithContext(() => options.onError!(err))
        void Promise.resolve(observed).catch(observerError => console.error(
          '[nuxt-use-query] subscription onError observer rejected:',
          observerError,
        ))
      }
      catch (observerError) {
        console.error('[nuxt-use-query] subscription onError observer threw:', observerError)
      }
    }
    else {
      console.error('[nuxt-use-query] subscription error', err)
    }
  }

  const handleMessage = async (raw: unknown): Promise<void> => {
    const message = parse(raw)
    await nuxtApp.runWithContext(() => options.onMessage(message))
  }

  const handleResync = async (request: TResync): Promise<void> => {
    if (!options.onResync)
      return
    await nuxtApp.runWithContext(() => options.onResync!(request))
  }

  const controller = createSubscriptionController<TResync>({
    source: hostSourceInScope(options.source),
    handleMessage,
    handleResync,
    handleError,
    setStatus: (s) => {
      // A fresh attempt clears the previous failure.
      if (s === 'connecting')
        error.value = undefined
      status.value = s
    },
  })

  const enabled = (): boolean => toValue(options.enabled ?? true)

  // The watch is created synchronously in the setup scope so it auto-disposes
  // on unmount. It stays inert until `onNuxtReady` flips `ready`: establishing
  // before hydration completes risks a replay-on-subscribe transport firing
  // `invalidateNuxtQueries` -> `refreshNuxtData` mid-hydration, which would drop
  // the just-seeded SWR timestamps and mutate `_asyncData` before components
  // finish hydrating their SSR markup.
  let ready = false
  // `onNuxtReady` is NOT scope-bound (it fires on an idle callback regardless of
  // unmount), so a component that unmounts before it fires would otherwise get a
  // late `activate()` with no surviving `onScopeDispose` to tear it down. Guard
  // every establishment path on `disposed`.
  let disposed = false
  watch(enabled, (on) => {
    if (!ready || disposed)
      return
    if (on)
      controller.activate()
    else
      controller.deactivate()
  }, { immediate: true })

  onNuxtReady(() => {
    if (disposed)
      return
    ready = true
    if (enabled())
      controller.activate()
  })

  // No scope when called from a plugin (app-lifetime): teardown then happens
  // only via `enabled = false`, which is acceptable for a singleton transport.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      controller.deactivate()
    })
  }

  return { status, error }
}
