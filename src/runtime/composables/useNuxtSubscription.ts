import type { MaybeRefOrGetter, Ref } from 'vue'
import { effectScope, getCurrentScope, onScopeDispose, ref, toValue, watch } from 'vue'
import { onNuxtReady, useNuxtApp } from '#app'

// `useNuxtSubscription` — a transport-agnostic bridge from a realtime message
// stream into the query cache. It deliberately does NOT own a connection:
// the caller injects the transport via `source`, and the bridge turns each
// message into explicit cache operations (the caller calls the already
// auto-imported `invalidateNuxtQueries` / `setQueryData` inside `onMessage`).
//
// Why a bridge and not a socket: the connection (auth, reconnect, channel
// multiplexing) is infrastructure that already lives in the host app
// (`nuxt-cf-jobs`, a vendor SDK, raw `useWebSocket`, …). Owning it here would
// compete with that. What every consumer re-invents instead is the
// "message -> data freshness" wiring; that is the seam this standardises.
//
// Boundary it does NOT cover: missed events while the socket was down. The
// bridge only sees messages that arrive. Cold-start recovery stays with
// `useNuxtQuery`'s mount refetch; mid-session reconnect recovery is the
// caller's `source` calling `ctx.resync()` -> the bridge runs `onReconnect`
// (typically a full `invalidateNuxtQueries(prefix)`).

export type NuxtSubscriptionStatus = 'idle' | 'connecting' | 'active' | 'error'

/**
 * Parse an untrusted socket frame into a trusted `TMessage` once, at the
 * boundary, before `onMessage` ever sees it. Either a plain function, or any
 * object exposing a synchronous `parse(raw)` that throws on invalid input
 * (a Zod schema). The thrown error is routed to `onError`.
 */
export type NuxtSubscriptionParser<TMessage>
  = | ((raw: unknown) => TMessage)
    | { parse: (raw: unknown) => TMessage }

/** The part of the source context the pure controller builds. */
export interface SubscriptionContextBase {
  /** Deliver a raw frame. Dropped if the subscription is torn down / disabled. */
  push: (raw: unknown) => void
  /** Aborted when the subscription is disabled or its scope disposes. */
  signal: AbortSignal
  /** Signal a transport reconnect so the bridge runs `onReconnect`. */
  resync: () => void
}

/** Handed to `source` so it can feed the bridge without importing internals. */
export interface NuxtSubscriptionSource extends SubscriptionContextBase {
  /**
   * Wire a transport connection-status signal to `resync`: whenever `status`
   * transitions back into a connected state *after having been connected once*,
   * the bridge runs `onReconnect`. Removes the hand-rolled "second open is a
   * reconnect" bookkeeping. Call it inside `source` with the status ref the
   * transport exposes, e.g. `ctx.resyncOn(status, s => s === 'open')`.
   */
  resyncOn: (status: MaybeRefOrGetter<unknown>, isConnected: (status: unknown) => boolean) => void
}

export interface UseNuxtSubscriptionOptions<TMessage> {
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
  source: (ctx: NuxtSubscriptionSource) => void | (() => void) | Promise<void | (() => void)>
  /** Map a parsed message to cache operations. Explicit by design. */
  onMessage: (message: TMessage) => void
  /** Parse-at-boundary for untrusted frames. Omit to pass frames through as-is. */
  schema?: NuxtSubscriptionParser<TMessage>
  /** Re-sync after a transport reconnect. Caller's `source` triggers it via `ctx.resync()`. */
  onReconnect?: () => void
  /** Per-message, parse, and establishment failures. No silent swallow. */
  onError?: (error: unknown) => void
  /** Gate the subscription. Default `true`. */
  enabled?: MaybeRefOrGetter<boolean>
}

export interface NuxtSubscription {
  /**
   * Bridge ESTABLISHMENT state, NOT live socket health (the bridge never sees
   * the transport, only its messages): `idle` before/after, `connecting` while
   * an async `source` resolves, `active` once established, `error` if `source`
   * itself fails. Per-message / parse / reconnect failures surface through
   * `error` + `onError`, not `status` (a parse blip shouldn't read as a dropped
   * connection); watch `error` if you need those.
   */
  status: Ref<NuxtSubscriptionStatus>
  /** Most recent error from `source` / parse / `onMessage` / `onReconnect`. */
  error: Ref<unknown>
}

type SourceCleanup = void | (() => void)

export interface SubscriptionControllerDeps {
  source: (ctx: SubscriptionContextBase) => SourceCleanup | Promise<SourceCleanup>
  /** Already wrapped: parse + deliver in context + catch. Called per frame. */
  handleMessage: (raw: unknown) => void
  /** Already wrapped: run `onReconnect` in context + catch. */
  handleReconnect: () => void
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
 * than stored, and `push` from a stale epoch is dropped.
 */
export function createSubscriptionController(deps: SubscriptionControllerDeps) {
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

    // A frame / resync only counts while THIS activation owns the bridge.
    const isCurrent = (): boolean => active && epoch === myEpoch && !ac.signal.aborted
    const ctx: SubscriptionContextBase = {
      signal: ac.signal,
      push: raw => void (isCurrent() && deps.handleMessage(raw)),
      resync: () => void (isCurrent() && deps.handleReconnect()),
    }

    let result: SourceCleanup | Promise<SourceCleanup>
    try {
      result = deps.source(ctx)
    }
    catch (error) {
      fail(error, myEpoch)
      return
    }

    if (result instanceof Promise) {
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

function composeCleanup(inner: SourceCleanup, stopScope: () => void): () => void {
  return () => {
    if (typeof inner === 'function')
      inner()
    stopScope()
  }
}

/**
 * Wrap a user `source` so it runs inside a detached effect scope. Any composable
 * or watcher it creates registers on that scope and is disposed when the
 * subscription tears down — the source runs post-hydration, outside the calling
 * component's scope, where `onScopeDispose` would otherwise be a no-op.
 */
// eslint-disable-next-line harlanzw/vue-require-composable-prefix -- factory that wraps a source in a scope, not a composable
function hostSourceInScope<TMessage>(
  source: UseNuxtSubscriptionOptions<TMessage>['source'],
): (ctx: SubscriptionContextBase) => SourceCleanup | Promise<SourceCleanup> {
  return (base) => {
    const scope = effectScope(true)
    const stopScope = (): void => void scope.stop()
    // Augment with `resyncOn`. The watch it creates registers on the scope below
    // (it's called during `source` execution inside `scope.run`), so it's torn
    // down with the subscription. `immediate` captures the initial connected
    // state so the FIRST reconnect isn't mistaken for the initial connect.
    const ctx: NuxtSubscriptionSource = {
      ...base,
      resyncOn: (status, isConnected) => {
        let connectedOnce = false
        watch(() => toValue(status), (value) => {
          if (!isConnected(value))
            return
          if (connectedOnce)
            base.resync()
          else
            connectedOnce = true
        }, { immediate: true })
      },
    }
    let result: SourceCleanup | Promise<SourceCleanup>
    try {
      result = scope.run(() => source(ctx)) as SourceCleanup | Promise<SourceCleanup>
    }
    catch (error) {
      stopScope()
      throw error
    }
    if (result instanceof Promise) {
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

export function useNuxtSubscription<TMessage = unknown>(
  options: UseNuxtSubscriptionOptions<TMessage>,
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
    if (options.onError)
      void nuxtApp.runWithContext(() => options.onError!(err))
    else
      console.error('[nuxt-use-query] subscription error', err)
  }

  const handleMessage = (raw: unknown): void => {
    let message: TMessage
    try {
      message = parse(raw)
    }
    catch (err) {
      handleError(err)
      return
    }
    try {
      void nuxtApp.runWithContext(() => options.onMessage(message))
    }
    catch (err) {
      handleError(err)
    }
  }

  const handleReconnect = (): void => {
    if (!options.onReconnect)
      return
    try {
      void nuxtApp.runWithContext(() => options.onReconnect!())
    }
    catch (err) {
      handleError(err)
    }
  }

  const controller = createSubscriptionController({
    source: hostSourceInScope(options.source),
    handleMessage,
    handleReconnect,
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
