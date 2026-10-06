import type { LifecycleQuery, QueryLifecycleOptions } from './query-lifecycle'
import { applyQueryLifecycle } from './query-lifecycle'

export function applyQueryAddon<TQuery extends LifecycleQuery>(query: TQuery, options: QueryLifecycleOptions) {
  const result = applyQueryLifecycle(query, options)
  const extensions = {
    displayData: result.displayData,
    isPlaceholderData: result.isPlaceholderData,
    isPending: result.isPending,
    isFetching: result.isFetching,
  }
  // Nuxt resolves its AsyncData promise to a separate instance.
  // Extend both surfaces before callers await the query.
  void Promise.resolve(query).then(instance => Object.assign(instance, extensions))
  return result
}
