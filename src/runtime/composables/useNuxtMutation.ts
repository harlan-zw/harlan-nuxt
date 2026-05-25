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

export interface NuxtMutation<TArgs, TResult> {
  /** Runs the mutation, then invalidation + callbacks. Resolves with the result. */
  mutate: (args: TArgs) => Promise<TResult>
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

  async function mutate(args: TArgs): Promise<TResult> {
    pending.value = true
    error.value = null
    // `onMutate` runs first so a caller can optimistically update the cache
    // and return a snapshot we'll hand back on rollback. If `onMutate` itself
    // throws we treat that as a mutation failure — the user-facing flow
    // should always reflect the optimistic write being abandoned.
    let context: TContext | undefined
    try {
      if (opts.onMutate)
        context = await opts.onMutate(args)
    }
    catch (e) {
      pending.value = false
      error.value = e
      opts.onSettled?.(undefined, e, args, context)
      if (!opts.onError)
        throw e
      opts.onError(e, args, context)
      return undefined as TResult
    }

    try {
      const result = await opts.mutation(args)
      const keys = typeof opts.invalidates === 'function'
        ? opts.invalidates(args, result)
        : (opts.invalidates ?? [])
      for (const prefix of keys)
        invalidateNuxtQueries(prefix)
      opts.onSuccess?.(result, args, context)
      opts.onSettled?.(result, null, args, context)
      return result
    }
    catch (e) {
      error.value = e
      opts.onSettled?.(undefined, e, args, context)
      if (!opts.onError)
        throw e
      opts.onError(e, args, context)
      return undefined as TResult
    }
    finally {
      pending.value = false
    }
  }

  return { mutate, pending, isPending: pending, error }
}
