import type { ModuleOptions } from './types'
import { resolve } from 'node:path'
import { addServerImports, createResolver, defineNuxtModule, useLogger } from '@nuxt/kit'
import { collectSetupWarnings, resolveLayerFile, resolveQueueNames } from './build/options'
import { installEventRegistryTemplates } from './build/registry'
import { resolveRuntimeFile } from './build/runtime-file'

export { generateEventRegistryContracts, generateEventRegistryTemplate, generateEventRegistryTypes } from './build/registry'
export type { ModuleOptions } from './types'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-domain-events',
    configKey: 'domainEvents',
    compatibility: { nuxt: '>=4.5.0 <6.0.0' },
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
    const logger = useLogger('@harlan-zw/nuxt-domain-events')
    for (const warning of collectSetupWarnings(options))
      logger.warn(warning)

    const cfJobsQueues = Object.keys((nuxt.options as unknown as {
      cfJobs?: { queues?: Record<string, unknown> }
    }).cfJobs?.queues ?? {})
    const layerRoots = [nuxt.options.rootDir, ...nuxt.options._layers.map(layer => layer.config.rootDir)]
    const resolvedOptions: ModuleOptions = {
      ...options,
      queues: resolveQueueNames(options.queues, cfJobsQueues),
      ...(options.queuedDeliveryContext
        ? { queuedDeliveryContext: resolveDeclaredFile('queuedDeliveryContext', options.queuedDeliveryContext, layerRoots) }
        : {}),
    }
    const observerPath = options.observer
      ? resolveDeclaredFile('observer', options.observer, layerRoots)
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
      { name: 'dispatchEventAndDrain', from: '#domain-events/server' },
      { name: 'planEvent', from: '#domain-events/server' },
      { name: 'commitEventPlan', from: '#domain-events/server' },
      { name: 'deliverQueuedListener', from: '#domain-events/server' },
      { name: 'handleQueuedListenerTerminalFailure', from: '#domain-events/server' },
    ])

    if (resolvedOptions.queuedDeliveryContext) {
      const deliveryContextPath = resolvedOptions.queuedDeliveryContext
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

function resolveDeclaredFile(option: string, path: string, roots: readonly string[]): string {
  const result = resolveLayerFile(path, roots)
  if (result._tag === 'err')
    throw new Error(`Unable to resolve domainEvents.${option} "${path}". Searched: ${result.searched.join(', ')}`)
  return result.path
}
