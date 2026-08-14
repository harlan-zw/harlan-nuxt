import { createSitemapEntries } from '../../core/sitemap'
import { loadCollectionIndex, loadCollectionNames } from '../storage'
import { defineNitroPlugin } from 'nitropack/runtime'

export default defineNitroPlugin((nitroApp) => {
  const hooks = nitroApp.hooks as typeof nitroApp.hooks & {
    hook: (name: string, callback: (context: { urls: unknown[] }) => Promise<void>) => void
  }
  hooks.hook('sitemap:input', async (context) => {
    const names = await loadCollectionNames()
    const collections = await Promise.all(names.map(loadCollectionIndex))
    context.urls.push(...createSitemapEntries(collections.flatMap(collection => collection.map(item => item.metadata))))
  })
})
