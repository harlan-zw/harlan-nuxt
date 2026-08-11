import { addPlugin, addRouteMiddleware, addServerHandler, addServerPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  meta: {
    name: 'fixture-runtime-module',
  },
  setup() {
    const resolver = createResolver(import.meta.url)
    addPlugin(resolver.resolve('./nuxt-plugin'))
    addRouteMiddleware({ name: 'fixture-runtime', path: resolver.resolve('./nuxt-middleware'), global: true })
    addServerPlugin(resolver.resolve('./nitro-plugin'))
    addServerHandler({ middleware: true, handler: resolver.resolve('./nitro-middleware') })
  },
})
