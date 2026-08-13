import { createSitemapEntries } from '../../core/sitemap'
import { loadCollection, loadCollectionNames } from '../storage'
import { defineNitroPlugin } from 'nitropack/runtime'

export default defineNitroPlugin((nitroApp) => {
  const hooks = nitroApp.hooks as typeof nitroApp.hooks & {
    hook: (name: string, callback: (context: { urls: unknown[] }) => Promise<void>) => void
  }
  hooks.hook('sitemap:input', async (context) => {
    const names = await loadCollectionNames()
    const collections = await Promise.all(names.map(loadCollection))
    context.urls.push(...createSitemapEntries(collections.flat()))
  })
})
