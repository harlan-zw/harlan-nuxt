import type { AsyncDataAddonInstance } from 'nuxt/app'
import type { QueryLifecycleOptions } from './query-lifecycle'
import { defineUseAsyncDataAddon, defineUseFetchAddon } from '#imports'
import { applyQueryLifecycle } from './query-lifecycle'

export interface QueryAddonOptions {
  _queryLifecycle: QueryLifecycleOptions
}

function setup(options: QueryAddonOptions) {
  return (asyncData: AsyncDataAddonInstance) => {
    const query = applyQueryLifecycle(asyncData, options._queryLifecycle)
    return {
      displayData: query.displayData,
      isPlaceholderData: query.isPlaceholderData,
      isPending: query.isPending,
      isFetching: query.isFetching,
    }
  }
}

export const createQueryFetchAddon = () => defineUseFetchAddon({ setup })
export const createQueryAsyncDataAddon = () => defineUseAsyncDataAddon({ setup })
