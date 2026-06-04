import type { Ref } from 'vue'
import { ref } from 'vue'
import { invalidateNuxtQueries } from './useQueryCache'

// `useNuxtMutation` is the write-side companion to `useNuxtQuery`. Mutations
// repeat the same shape: call an async fn, track a loading flag, then refetch
// affected reads. `useNuxtQuery` registers every read via Nuxt's own
// `_asyncData` — this composable closes the loop so a mutation declares which
// key prefixes it invalidates and the matching reads refetch automatically.
//
// Optimistic update support (TanStack-style):
//   - `onMutate(args)` runs BEFORE the mutation, can write to the cache via
//     `setQueryData`, returns a context (e.g. the previous snapshot).
//   - `onError(error, args, context)` receives the context for rollback.
//   - `onSuccess(result, args, context)` receives the context too.
//   - `onSettled(data, error, args, context)` always runs.
//
// No baked-in toasts (caller owns toast copy via the handlers).

export interface UseNuxtMutationOptions<TArgs, TResult, TContext = unknown> {
  /** The mutation call — typically a $fetch POST / PATCH / DELETE. */
  mutation: (args: TArgs) => Promise<TResult>
  /**
   * Query key prefixes to invalidate (refetch) once the mutation succeeds.
   * A function form receives the args + result for dynamic keys.
   */
  invalidates?: string[] | ((args: TArgs, result: TResult) => string[])
  /**
   * Runs BEFORE the mutation. Use to optimistically write the cache via
   * `setQueryData` and capture a snapshot for rollback. The returned value is
   * passed through to `onSuccess` / `onError` / `onSettled` as `context`.
   */
  onMutate?: (args: TArgs) => TContext | Promise<TContext>
  /** Runs after a successful mutation, once invalidation has been triggered. */
  onSuccess?: (result: TResult, args: TArgs, context: TContext | undefined) => void
  /**
   * Runs on failure. The optimistic-update rollback site — call
   * `setQueryData(key, context.previous)` here. When provided the error is
   * swallowed; when omitted the error is re-thrown for the caller to handle.
   */
  onError?: (error: unknown, args: TArgs, context: TContext | undefined) => void
  /**
   * Runs after either path (success or error). Receives both `data` and
   * `error` (one is non-null). The last hook to fire — use for telemetry or
   * final cleanup.
   */
  onSettled?: (
    data: TResult | undefined,
    error: unknown,
    args: TArgs,
    context: TContext | undefined,
  ) => void
}

/**
 * Tagged result of a mutation. `mutateSafe` returns this instead of throwing,
 * so an expected mutation failure shows up in the call signature as a value
 * rather than a control-flow jump. Discriminate on `_tag`.
 */
export type MutationResult<TResult>
  = | { _tag: 'ok', data: TResult }
    | { _tag: 'err', error: unknown }

export interface NuxtMutation<TArgs, TResult> {
  /**
   * Runs the mutation, then invalidation + callbacks. Resolves with the
   * result. Throwing path (TanStack-compatible): rejects on failure unless an
   * `onError` handler swallows it. Prefer `mutateSafe` when you want the
   * failure as a value.
   */
  mutate: (args: TArgs) => Promise<TResult>
  /**
   * Errors-as-values variant of `mutate`. Never throws: always resolves with a
   * tagged `{ _tag: 'ok', data } | { _tag: 'err', error }`. The same
   * `onMutate` / `onSuccess` / `onError` / `onSettled` side-effects still fire;
   * this only changes how the outcome is returned to the caller.
   */
  mutateSafe: (args: TArgs) => Promise<MutationResult<TResult>>
  /** True while the mutation is in flight. */
  pending: Ref<boolean>
  /** TanStack-compatible alias for `pending`. */
  isPending: Ref<boolean>
  /** The last error, or null. Cleared at the start of each `mutate`. */
  error: Ref<unknown>
}

export function useNuxtMutation<TArgs = void, TResult = unknown, TContext = unknown>(
  opts: UseNuxtMutationOptions<TArgs, TResult, TContext>,
): NuxtMutation<TArgs, TResult> {
  const pending = ref(false)
  const error = ref<unknown>(null)

  // Runs one lifecycle hook in isolation. Awaited (so a promise-returning
  // handler's rejection is caught here, not left dangling after the mutation
  // resolved), reported (never swallowed silently), and the failure is returned
  // so callers can decide whether to surface it. `onMutate` is NOT run through
  // here: it gates the mutation, so its throw is the mutation's own failure.
  async function runHook(invoke: () => void | Promise<void>): Promise<unknown> {
    try {
      await invoke()
      return undefined
    }
    catch (e) {
      console.error('[nuxt-use-query] a mutation lifecycle hook threw:', e)
      return e
    }
  }

  // Updates reactive state, then fires the outcome's hooks (settle before error,
  // matching the rollback contract). Returns the outcome plus the first hook
  // failure observed — both hooks always run regardless of an earlier throw.
  async function settle(
    outcome: MutationResult<TResult>,
    args: TArgs,
    context: TContext | undefined,
  ): Promise<{ outcome: MutationResult<TResult>, hookError: unknown }> {
    error.value = outcome._tag === 'err' ? outcome.error : null
    pending.value = false
    const failures = outcome._tag === 'ok'
      ? [
          await runHook(() => opts.onSuccess?.(outcome.data, args, context)),
          await runHook(() => opts.onSettled?.(outcome.data, null, args, context)),
        ]
      : [
          await runHook(() => opts.onSettled?.(undefined, outcome.error, args, context)),
          await runHook(() => opts.onError?.(outcome.error, args, context)),
        ]
    return { outcome, hookError: failures.find(e => e !== undefined) }
  }

  // Total core: never throws. Resolves to the outcome plus the first lifecycle
  // hook failure. `mutate` surfaces a failed rollback by throwing it; the
  // value-returning `mutateSafe` returns the outcome and relies on the report.
  async function runMutation(args: TArgs): Promise<{ outcome: MutationResult<TResult>, hookError: unknown }> {
    pending.value = true
    error.value = null
    // `onMutate` runs first so a caller can optimistically update the cache and
    // return a snapshot we'll hand back on rollback. A throw here means the
    // optimistic write is abandoned, so it's surfaced as the Err outcome.
    let context: TContext | undefined
    try {
      if (opts.onMutate)
        context = await opts.onMutate(args)
    }
    catch (e) {
      return settle({ _tag: 'err', error: e }, args, context)
    }

    try {
      const result = await opts.mutation(args)
      const keys = typeof opts.invalidates === 'function'
        ? opts.invalidates(args, result)
        : (opts.invalidates ?? [])
      for (const prefix of keys)
        invalidateNuxtQueries(prefix)
      return settle({ _tag: 'ok', data: result }, args, context)
    }
    catch (e) {
      return settle({ _tag: 'err', error: e }, args, context)
    }
  }

  async function mutate(args: TArgs): Promise<TResult> {
    const { outcome, hookError } = await runMutation(args)
    if (outcome._tag === 'err') {
      // No handler: the mutation error is unhandled, re-throw it (TanStack
      // parity). With a handler: `onError` ran (the rollback site) — if it
      // itself threw, the optimistic cache may be corrupt, so surface that
      // rather than resolving as if cleanly handled.
      if (!opts.onError)
        throw outcome.error
      if (hookError !== undefined)
        throw hookError
      return undefined as TResult
    }
    return outcome.data
  }

  async function mutateSafe(args: TArgs): Promise<MutationResult<TResult>> {
    const { outcome } = await runMutation(args)
    return outcome
  }

  return { mutate, mutateSafe, pending, isPending: pending, error }
}
