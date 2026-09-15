import { defineNuxtPlugin } from '#app'
import { formatPayloadUsage, trackPayloadUsage } from '../payload-usage'

export default defineNuxtPlugin({
  name: 'nuxt-dx:payload-usage',
  order: -29,
  dependsOn: ['nuxt:revive-payload:client'],
  setup(nuxtApp) {
    // A prerender build only collects when a browser audit explicitly requests it.
    if (!import.meta.dev && window.__NUXT_DX_PAYLOAD_ENABLED__ !== true)
      return
    if (!nuxtApp.payload.serverRendered) {
      window.__NUXT_DX_PAYLOAD__ = { status: 'unavailable', reason: 'This page did not render on the server.' }
      return
    }
    const tracker = trackPayloadUsage(nuxtApp.payload.data)
    let finished = false
    nuxtApp.hook('app:error', () => {
      finished = true
      tracker.finish()
      window.__NUXT_DX_PAYLOAD__ = { status: 'unavailable', reason: 'The app failed during hydration.' }
    })
    nuxtApp.hook('app:suspense:resolve', async () => {
      if (finished)
        return
      finished = true
      const entries = tracker.finish()
      window.__NUXT_DX_PAYLOAD__ = { status: 'complete', entries }
      for (const entry of entries) {
        if (entry.status !== 'tracked' || !entry.unread.length)
          continue
        const message = formatPayloadUsage(entry)
        if (import.meta.dev) {
          console.info(`[nuxt-dx] ${message}`)
          await nuxtApp.callHook('nuxt-dx:issue', { kind: 'warning', message })
        }
      }
    })
  },
})
