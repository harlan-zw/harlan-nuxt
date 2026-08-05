import type { ModuleOptions } from './types'
import { resolve } from 'node:path'
import { addServerImports, createResolver, defineNuxtModule } from '@nuxt/kit'
import { installEventRegistryTemplates } from './build/registry'

export { generateEventRegistryTemplate, generateEventRegistryTypes } from './build/registry'
export type { ModuleOptions } from './types'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@nuxtseo/event-listeners',
    configKey: 'eventListeners',
  },
  defaults: {
    eventsDir: 'server/events',
    listenersDir: 'server/listeners',
    eventsPattern: '**/*.ts',
    listenersPattern: '**/*.ts',
    eventsIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    listenersIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    scanLayers: true,
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const cfJobsQueues = Object.keys((nuxt.options as unknown as {
      cfJobs?: { queues?: Record<string, unknown> }
    }).cfJobs?.queues ?? {})
    const resolvedOptions: ModuleOptions = {
      ...options,
      queues: options.queues ?? cfJobsQueues,
    }
    const observerPath = options.observer
      ? resolve(nuxt.options.rootDir, options.observer)
      : resolver.resolve('./runtime/server/observer')
    nuxt.options.alias['#event-listeners/observer'] = observerPath
    const nitro = ((nuxt.options as unknown as { nitro?: Record<string, any> }).nitro ??= {})
    nitro.alias ||= {}
    nitro.alias['#event-listeners/observer'] = observerPath

    installEventRegistryTemplates(resolvedOptions, nuxt, resolve(nuxt.options.buildDir, 'event-listeners'))

    addServerImports([
      { name: 'defineEvent', from: resolver.resolve('./runtime/server/definitions') },
      { name: 'defineListener', from: resolver.resolve('./runtime/server/definitions') },
      { name: 'dispatchEvent', from: '#event-listeners/server' },
      { name: 'planEvent', from: '#event-listeners/server' },
      { name: 'commitEventPlan', from: '#event-listeners/server' },
      { name: 'deliverQueuedListener', from: '#event-listeners/server' },
      { name: 'handleQueuedListenerTerminalFailure', from: '#event-listeners/server' },
    ])

    if (options.queuedDeliveryContext) {
      const deliveryContextPath = resolve(nuxt.options.rootDir, options.queuedDeliveryContext)
      nuxt.options.alias['#event-listeners/context'] = deliveryContextPath
      nitro.alias['#event-listeners/context'] = deliveryContextPath
      nuxt.hook('cf-jobs:registry:sources' as never, ((context: { sources: Array<{ file: string, name?: string }> }) => {
        context.sources.push({
          file: resolver.resolve('./runtime/server/jobs/deliver-listener.ts'),
          name: 'events/deliver-listener',
        })
      }) as never)
    }
  },
})
