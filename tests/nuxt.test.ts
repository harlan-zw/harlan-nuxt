import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNuxt } from '@nuxt/kit'
import { loadNuxt } from 'nuxt'
import { describe, expect, it } from 'vitest'
import { generateEventRegistryTemplate } from '../src/build/registry'
import eventListenersModule from '../src/module'

describe('nuxt module integration', () => {
  it('wires the generated server alias and discovers app plus Nuxt layer sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-event-listeners-'))
    const layer = join(root, 'layer')
    const appListener = join(root, 'server/listeners/app.ts')
    await Promise.all([
      mkdir(join(root, 'server/events'), { recursive: true }),
      mkdir(join(root, 'server/listeners'), { recursive: true }),
      mkdir(join(layer, 'server/listeners'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(root, 'server/events/event.ts'), `export default defineEvent({ name: 'test:event', transport: { _tag: 'local' }, input: { parse: input => input } })`),
      writeFile(appListener, `export default defineListener({ name: 'app-listener', event: 'test:event', handle: () => {} })`),
      writeFile(join(layer, 'server/listeners/layer.ts'), `export default defineListener({ name: 'layer-listener', event: 'test:event', handle: () => {} })`),
      writeFile(join(layer, 'nuxt.config.ts'), `export default defineNuxtConfig({})`),
    ])

    const nuxt = await loadNuxt({
      cwd: root,
      ready: false,
      overrides: {
        dev: true,
        extends: [layer],
        modules: [[eventListenersModule, {}]],
      },
    })
    await nuxt.ready()
    expect(nuxt.options.alias['#event-listeners/server']).toBeTruthy()
    const template = await generateEventRegistryTemplate({}, {
      rootDir: nuxt.options.rootDir,
      layerRoots: [nuxt.options.rootDir, ...nuxt.options._layers.map(current => current.config.rootDir)],
    }, join(nuxt.options.buildDir, 'event-listeners'))
    expect(template).toContain('app-listener')
    expect(template).toContain('layer-listener')

    const registryPath = join(nuxt.options.buildDir, 'event-listeners/registry.mjs')
    const contractsPath = join(nuxt.options.buildDir, 'event-listeners/contracts.ts')
    nuxt.hook('builder:generateApp' as never, (async (input: { filter?: (template: { dst?: string }) => boolean }) => {
      for (const current of nuxt.options.build.templates) {
        if (!current.dst || !current.getContents)
          continue
        if (input.filter && !input.filter(current))
          continue
        await mkdir(join(current.dst, '..'), { recursive: true })
        await writeFile(current.dst, await current.getContents({ nuxt } as never))
      }
    }) as never)
    await writeFile(appListener, `export default defineListener({ name: 'app-listener-regenerated', event: 'test:event', handle: () => {} })`)
    await (nuxt.callHook as unknown as (name: string, event: string, path: string) => Promise<void>)(
      'builder:watch',
      'change',
      appListener,
    )
    const [regenerated, regeneratedContracts] = await Promise.all([
      readFile(registryPath, 'utf8'),
      readFile(contractsPath, 'utf8'),
    ])
    expect(regenerated).toContain('app-listener-regenerated')
    expect(regenerated).not.toContain('name: "app-listener"')
    expect(regeneratedContracts).toContain('AssertListenerPayload_app_listener_regenerated_')
    expect(regeneratedContracts).not.toContain('AssertListenerPayload_app_listener_0')
    await nuxt.close()
  })

  it('contributes the lazy generic delivery job only with an explicit queued context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-event-listeners-queued-'))
    await Promise.all([
      mkdir(join(root, 'server/events'), { recursive: true }),
      mkdir(join(root, 'server/listeners'), { recursive: true }),
      mkdir(join(root, 'server/utils'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(root, 'server/events/event.ts'), `export default defineEvent({ name: 'test:event', transport: { _tag: 'transfer', version: 1 }, codec: { parse: input => input, encode: payload => payload } })`),
      writeFile(join(root, 'server/listeners/listener.ts'), `export default defineListener({ name: 'queued', event: 'test:event', execution: { _tag: 'queued', queue: 'notifications', publication: 'immediate' }, idempotency: { key: () => 'queued' }, handle: () => {} })`),
      writeFile(join(root, 'server/utils/event-context.ts'), `export function createQueuedEventListenerContext() { return { services: undefined, idempotency: { run: async (_input, effect) => ({ _tag: 'executed', value: await effect() }) } } }`),
    ])
    const nuxt = await loadNuxt({
      cwd: root,
      ready: false,
      overrides: {
        dev: true,
        modules: [[eventListenersModule, {
          queues: ['notifications'],
          queuedDeliveryContext: 'server/utils/event-context.ts',
        }]],
      },
    })
    await nuxt.ready()
    const contribution = { sources: [] as Array<{ file: string, name?: string }> }
    const callHook = nuxt.callHook as unknown as (name: string, context: typeof contribution) => Promise<void>
    await callHook.call(nuxt, 'cf-jobs:registry:sources', contribution)

    expect(nuxt.options.alias['#event-listeners/context']).toBe(join(root, 'server/utils/event-context.ts'))
    expect(contribution.sources).toEqual([expect.objectContaining({ name: 'events/deliver-listener' })])
    expect(await readFile(contribution.sources[0]!.file, 'utf8')).toContain('queue: \'maintenance\'')
    await nuxt.close()
  })

  it('removes literal-disabled listeners from the production server output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-event-listeners-disabled-'))
    await Promise.all([
      mkdir(join(root, 'server/api'), { recursive: true }),
      mkdir(join(root, 'server/events'), { recursive: true }),
      mkdir(join(root, 'server/listeners'), { recursive: true }),
      symlink(join(import.meta.dirname, '../node_modules'), join(root, 'node_modules'), 'dir'),
    ])
    await Promise.all([
      writeFile(join(root, 'server/api/test.get.ts'), `export default defineEventHandler(() => dispatchEvent('test:event', {}))`),
      writeFile(join(root, 'server/events/event.ts'), `export default defineEvent({ name: 'test:event', transport: { _tag: 'local' }, input: { parse: input => input } })`),
      writeFile(join(root, 'server/listeners/enabled.ts'), `export default defineListener({ name: 'enabled-listener', event: 'test:event', handle: () => { console.info('EVENT_LISTENER_ENABLED_BUILD_MARKER') } })`),
      writeFile(join(root, 'server/listeners/disabled.ts'), `export default defineListener({ name: 'disabled-listener', event: 'test:event', enabled: false, handle: () => { console.info('EVENT_LISTENER_DISABLED_BUILD_MARKER') } })`),
    ])

    const nuxt = await loadNuxt({
      cwd: root,
      ready: true,
      overrides: {
        dev: false,
        modules: [[eventListenersModule, {}]],
      },
    })
    await buildNuxt(nuxt)
    await nuxt.close()

    const serverDir = join(root, '.output/server')
    const outputFiles = (await readdir(serverDir, { recursive: true }))
      .filter(file => file.endsWith('.mjs'))
    const output = (await Promise.all(outputFiles.map(file => readFile(join(serverDir, file), 'utf8')))).join('\n')
    expect(output).toContain('EVENT_LISTENER_ENABLED_BUILD_MARKER')
    expect(output).not.toContain('EVENT_LISTENER_DISABLED_BUILD_MARKER')
  }, 30_000)

  it('fails a production Nuxt build when a strict event contract has no listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-event-listeners-empty-'))
    await Promise.all([
      mkdir(join(root, 'server/events'), { recursive: true }),
      symlink(join(import.meta.dirname, '../node_modules'), join(root, 'node_modules'), 'dir'),
    ])
    await writeFile(join(root, 'server/events/event.ts'), `export default defineEvent({ name: 'test:empty', transport: { _tag: 'local' }, input: { parse: input => input } })`)
    await expect(loadNuxt({
      cwd: root,
      ready: true,
      overrides: {
        dev: false,
        modules: [[eventListenersModule, {}]],
      },
    })).rejects.toThrow(/Event contract\(s\) have no listeners: test:empty/)
  }, 30_000)
})
