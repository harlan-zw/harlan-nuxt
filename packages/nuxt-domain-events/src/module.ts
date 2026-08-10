import type { ModuleOptions } from './types'
import { resolve } from 'node:path'
import { addServerImports, createResolver, defineNuxtModule } from '@nuxt/kit'
import { installEventRegistryTemplates } from './build/registry'
import { resolveRuntimeFile } from './build/runtime-file'

export { generateEventRegistryContracts, generateEventRegistryTemplate, generateEventRegistryTypes } from './build/registry'
export type { ModuleOptions } from './types'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-domain-events',
    configKey: 'domainEvents',
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
  async setup(options, nuxt) {
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
    nuxt.options.alias['#domain-events/observer'] = observerPath
    const nitro = ((nuxt.options as unknown as { nitro?: Record<string, any> }).nitro ??= {})
    nitro.alias ||= {}
    nitro.alias['#domain-events/observer'] = observerPath

    installEventRegistryTemplates(resolvedOptions, nuxt, resolve(nuxt.options.buildDir, 'domain-events'))

    addServerImports([
      { name: 'defineEvent', from: resolver.resolve('./runtime/server/definitions') },
      { name: 'defineListener', from: resolver.resolve('./runtime/server/definitions') },
      { name: 'dispatchEvent', from: '#domain-events/server' },
      { name: 'planEvent', from: '#domain-events/server' },
      { name: 'commitEventPlan', from: '#domain-events/server' },
      { name: 'deliverQueuedListener', from: '#domain-events/server' },
      { name: 'handleQueuedListenerTerminalFailure', from: '#domain-events/server' },
    ])

    if (options.queuedDeliveryContext) {
      const deliveryContextPath = resolve(nuxt.options.rootDir, options.queuedDeliveryContext)
      const deliveryJobPath = await resolveRuntimeFile(resolver, './runtime/server/jobs/deliver-listener')
      nuxt.options.alias['#domain-events/context'] = deliveryContextPath
      nitro.alias['#domain-events/context'] = deliveryContextPath
      nuxt.hook('cf-jobs:registry:sources' as never, ((context: { sources: Array<{ file: string, name?: string }> }) => {
        context.sources.push({
          file: deliveryJobPath,
          name: 'events/deliver-listener',
        })
      }) as never)
    }
  },
})
