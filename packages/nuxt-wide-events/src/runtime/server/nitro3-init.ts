import { defineNitroPlugin, useNitroApp } from '#nuxt-wide-events/nitro'

// Install parallel dispatch before application plugins register their drains.
export default defineNitroPlugin(() => {
  useNitroApp()
})
