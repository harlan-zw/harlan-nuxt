import type { ModuleOptions } from './types'
import { defineNuxtModule } from '@nuxt/kit'
import defu from 'defu'

export type { ModuleOptions } from './types'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-jev',
    configKey: 'jev',
    compatibility: {
      nuxt: '>=4.5.0 <6.0.0',
    },
  },
  defaults: {},
  setup(options, nuxt) {
    nuxt.options.runtimeConfig.jev = defu(
      nuxt.options.runtimeConfig.jev as Record<string, unknown> | undefined,
      {
        apiToken: options.apiToken ?? '',
        accountId: options.accountId ?? '',
        gatewayId: options.gatewayId ?? '',
        model: options.model ?? 'typesafe/jev',
        cacheTtl: options.cacheTtl ?? 0,
        seatModes: options.seatModes ?? '',
        defaultMode: options.defaultMode ?? 'shadow',
      },
    ) as typeof nuxt.options.runtimeConfig.jev
  },
})
