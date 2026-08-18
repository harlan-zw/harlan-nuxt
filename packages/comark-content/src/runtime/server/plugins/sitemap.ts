import { defineNitroPlugin } from 'nitropack/runtime'
import { createSitemapEntries } from '../../core/sitemap'
import { loadCollectionIndex, loadCollectionManifest } from '../storage'

export default defineNitroPlugin((nitroApp) => {
  const hooks = nitroApp.hooks as typeof nitroApp.hooks & {
    hook: (name: string, callback: (context: { urls: unknown[] }) => Promise<void>) => void
  }
  hooks.hook('sitemap:input', async (context) => {
    const manifest = await loadCollectionManifest()
    const included = manifest.filter(entry => entry.sitemap).map(entry => entry.name)
    const collections = await Promise.all(included.map(loadCollectionIndex))
    context.urls.push(...createSitemapEntries(collections.flatMap(collection => collection.map(item => item.metadata))))
  })
})
