import { addPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  enabled?: boolean
  position?: 'bottom-left' | 'bottom-right'
  sourceRoot?: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlanzw/nuxt-dx',
    configKey: 'nuxtDx',
  },
  defaults: {
    enabled: true,
    position: 'bottom-right',
  },
  setup(options, nuxt) {
    if (!nuxt.options.dev || !options.enabled)
      return

    const publicConfig = nuxt.options.runtimeConfig.public as Record<string, unknown>
    publicConfig.nuxtDx = {
      position: options.position,
      sourceRoot: options.sourceRoot ?? nuxt.options.rootDir,
    }

    const resolver = createResolver(import.meta.url)
    addPlugin({ mode: 'client', src: resolver.resolve('./runtime/app/plugins/error-overlay.client') })
  },
})
