import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractEventMeta } from '../src/build/extract-event-meta'
import { extractListenerMeta } from '../src/build/extract-listener-meta'
import { buildEventRegistryPlan, generateEventRegistryContracts, generateEventRegistryTemplate, generateEventRegistryTypes } from '../src/build/registry'

async function sourceTree() {
  const root = await mkdtemp(join(tmpdir(), 'event-listeners-'))
  const layer = join(root, 'layer')
  await Promise.all([
    mkdir(join(root, 'server/events'), { recursive: true }),
    mkdir(join(root, 'server/listeners'), { recursive: true }),
    mkdir(join(layer, 'server/events'), { recursive: true }),
    mkdir(join(layer, 'server/listeners'), { recursive: true }),
  ])
  return { root, layer, context: { rootDir: root, layerRoots: [root, layer] }, templateDir: join(root, '.nuxt/event-listeners') }
}

function transferEvent(name: string, enabled = true) {
  return `
export default defineEvent({
  name: '${name}',
  enabled: ${enabled},
  transport: { _tag: 'transfer', version: 1, maxBytes: 4096 },
  codec: { parse: input => input, encode: payload => payload },
})
`
}

function localEvent(name: string) {
  return `
export default defineEvent({ name: '${name}', transport: { _tag: 'local' }, input: { parse: input => input } })
`
}

function queuedListener(name: string, event: string, queue = 'events', publication = 'immediate') {
  return `
export default defineListener({
  name: '${name}',
  event: '${event}',
  execution: { _tag: 'queued', queue: '${queue}', publication: '${publication}', tries: 3, backoff: [5, 30] },
  idempotency: { key: payload => payload.id },
  handle: async payload => payload,
})
`
}

describe('event registry build', () => {
  it('extracts Laravel-compatible sync propagation when execution is omitted', () => {
    expect(extractListenerMeta(`export default defineListener({ name: 'audit', event: 'audit:ran', owner: 'audit', handle: () => {} })`, 'listener.ts')).toMatchObject({
      name: 'audit',
      event: 'audit:ran',
      owner: 'audit',
      hasInput: false,
      execution: { _tag: 'sync', failure: 'propagate' },
    })
  })

  it('discovers listeners from Nuxt layers and renders only lazy matching imports', async () => {
    const tree = await sourceTree()
    await Promise.all([
      writeFile(join(tree.root, 'server/events/root.ts'), transferEvent('root:event')),
      writeFile(join(tree.layer, 'server/events/layer.ts'), transferEvent('layer:event')),
      writeFile(join(tree.root, 'server/listeners/root.ts'), queuedListener('root-listener', 'root:event')),
      writeFile(join(tree.layer, 'server/listeners/layer.ts'), `export default defineListener({ name: 'layer-listener', event: 'layer:event', handle: () => {} })`),
    ])
    const template = await generateEventRegistryTemplate({ queues: ['events'], queuedDeliveryContext: 'server/event-context.ts', scanLayers: true }, tree.context, tree.templateDir)

    expect(template).toContain('root-listener')
    expect(template).toContain('layer-listener')
    expect(template).toMatch(/load: \(\) => import\(/)
    expect(template).not.toMatch(/^import .*root-listener/m)
    expect(template).not.toMatch(/^import .*layer-listener/m)
  })

  it('removes disabled definitions and changes the HMR manifest hash after source changes', async () => {
    const tree = await sourceTree()
    const eventFile = join(tree.root, 'server/events/event.ts')
    const listenerFile = join(tree.root, 'server/listeners/listener.ts')
    await writeFile(eventFile, transferEvent('root:event'))
    await writeFile(listenerFile, queuedListener('listener', 'root:event'))
    const before = await buildEventRegistryPlan({ queues: ['events'], queuedDeliveryContext: 'server/event-context.ts' }, tree.context, tree.templateDir)

    await writeFile(listenerFile, queuedListener('listener', 'root:event').replace('name: \'listener\',', 'name: \'listener\', enabled: false,'))
    const after = await buildEventRegistryPlan({ queues: ['events'], queuedDeliveryContext: 'server/event-context.ts', allowEmptyEvents: ['root:event'] }, tree.context, tree.templateDir)

    expect(before.listeners).toHaveLength(1)
    expect(after.listeners).toHaveLength(0)
    expect(after.manifestHash).not.toBe(before.manifestHash)
  })

  it('fails when host-required registrations are disabled or missing', async () => {
    const tree = await sourceTree()
    await writeFile(join(tree.root, 'server/events/event.ts'), transferEvent('root:event'))
    await writeFile(join(tree.root, 'server/listeners/listener.ts'), queuedListener('listener', 'root:event').replace('name: \'listener\',', 'name: \'listener\', enabled: false,'))
    await expect(buildEventRegistryPlan({
      queues: ['events'],
      requiredEvents: ['root:event'],
      requiredListeners: ['listener'],
    }, tree.context, tree.templateDir)).rejects.toThrow(/Missing required listener registration/)
  })

  it('fails strict builds for empty events unless the contract is explicitly allowed empty', async () => {
    const tree = await sourceTree()
    await writeFile(join(tree.root, 'server/events/event.ts'), localEvent('extension:event'))

    await expect(buildEventRegistryPlan({}, tree.context, tree.templateDir)).rejects.toThrow(/Event contract\(s\) have no listeners: extension:event/)
    await expect(buildEventRegistryPlan({ allowEmptyEvents: ['extension:event'] }, tree.context, tree.templateDir)).resolves.toMatchObject({ listeners: [] })
    await expect(buildEventRegistryPlan({ allowEmptyEvents: ['typo:event'] }, tree.context, tree.templateDir)).rejects.toThrow(/Unknown allowEmptyEvents/)
  })

  it('rejects other execution modes mixed into an after-commit event', async () => {
    const tree = await sourceTree()
    await Promise.all([
      writeFile(join(tree.root, 'server/events/event.ts'), transferEvent('root:event')),
      writeFile(join(tree.root, 'server/listeners/immediate.ts'), queuedListener('immediate', 'root:event', 'events', 'immediate')),
      writeFile(join(tree.root, 'server/listeners/queued.ts'), queuedListener('after-commit', 'root:event', 'events', 'after-commit')),
      writeFile(join(tree.root, 'server/listeners/sync.ts'), `export default defineListener({ name: 'sync', event: 'root:event', handle: () => {} })`),
    ])

    await expect(buildEventRegistryPlan({
      queues: ['events'],
      queuedDeliveryContext: 'server/event-context.ts',
    }, tree.context, tree.templateDir)).rejects.toThrow(/mixes immediate and after-commit/)
  })

  it('rejects definitions which are not default exports', () => {
    expect(() => extractListenerMeta(`defineListener({ name: 'audit', event: 'audit:ran', handle: () => {} })`, 'listener.ts')).toThrow(/must default-export/)
  })

  it('rejects explicit undefined listener input instead of bypassing event payload checks', () => {
    expect(() => extractListenerMeta(`export default defineListener({ name: 'audit', event: 'audit:ran', input: undefined, handle: () => {} })`, 'listener.ts')).toThrow(/input must be a parser/)
    expect(() => extractListenerMeta(`export default defineListener({ name: 'audit', event: 'audit:ran', input: void 0, handle: () => {} })`, 'listener.ts')).toThrow(/input must be a parser/)
  })

  it('rejects object spreads that could hide listener routing metadata', () => {
    expect(() => extractListenerMeta(`
      const hidden = { execution: { _tag: 'queued', queue: 'missing', publication: 'immediate' } }
      export default defineListener({ ...hidden, name: 'audit', event: 'audit:ran', handle: () => {} })
    `, 'listener.ts')).toThrow(/object spreads/)
    expect(() => extractListenerMeta(`
      const hidden = { queue: 'missing' }
      export default defineListener({
        name: 'audit', event: 'audit:ran',
        execution: { ...hidden, _tag: 'queued', publication: 'immediate' },
        idempotency: { key: () => 'audit' }, handle: () => {},
      })
    `, 'listener.ts')).toThrow(/object spreads/)
  })

  it('rejects transport spreads that could hide transfer metadata', () => {
    expect(() => extractEventMeta(`
      const hidden = { version: 1 }
      export default defineEvent({
        name: 'audit:ran', transport: { ...hidden, _tag: 'transfer' },
        codec: { parse: input => input, encode: payload => payload },
      })
    `, 'event.ts')).toThrow(/object spreads/)
  })

  it('rejects computed and duplicate routing metadata', () => {
    expect(() => extractListenerMeta(`
      const execution = { _tag: 'queued', queue: 'missing', publication: 'immediate' }
      export default defineListener({
        name: 'audit', event: 'audit:ran', ['execution']: execution,
        idempotency: { key: () => 'audit' }, handle: () => {},
      })
    `, 'listener.ts')).toThrow(/computed properties/)
    expect(() => extractEventMeta(`
      export default defineEvent({
        name: 'audit:ran', ['enabled']: false,
        transport: { _tag: 'local' }, input: { parse: input => input },
      })
    `, 'event.ts')).toThrow(/computed properties/)
    expect(() => extractListenerMeta(`
      export default defineListener({
        name: 'audit', event: 'audit:ran',
        execution: { _tag: 'sync', failure: 'propagate' },
        execution: { _tag: 'deferred', failure: 'isolate' }, handle: () => {},
      })
    `, 'listener.ts')).toThrow(/duplicate property/)
  })

  it('rejects queued listeners without delivery context and queued shouldHandle conditions', async () => {
    const tree = await sourceTree()
    await writeFile(join(tree.root, 'server/events/event.ts'), transferEvent('root:event'))
    await writeFile(join(tree.root, 'server/listeners/listener.ts'), queuedListener('listener', 'root:event'))

    await expect(buildEventRegistryPlan({ queues: ['events'] }, tree.context, tree.templateDir)).rejects.toThrow(/queuedDeliveryContext/)
    expect(() => extractListenerMeta(
      queuedListener('listener', 'root:event').replace('idempotency:', 'shouldHandle: () => true,\n  idempotency:'),
      'listener.ts',
    )).toThrow(/queued listener cannot declare shouldHandle/)
  })

  it('allows isolated layers to defer external event and queue validation explicitly', async () => {
    const tree = await sourceTree()
    await writeFile(join(tree.root, 'server/listeners/listener.ts'), queuedListener('external-listener', 'app:event', 'app-queue'))

    await expect(buildEventRegistryPlan({
      allowExternalEvents: true,
      allowExternalQueues: true,
      queuedDeliveryContext: 'server/event-context.ts',
    }, tree.context, tree.templateDir)).resolves.toMatchObject({ listeners: [expect.objectContaining({ meta: expect.objectContaining({ event: 'app:event' }) })] })
    await expect(buildEventRegistryPlan({
      allowExternalEvents: false,
      allowExternalQueues: true,
      queuedDeliveryContext: 'server/event-context.ts',
    }, tree.context, tree.templateDir)).rejects.toThrow(/Unknown event/)
  })

  it('widens isolated layer dispatch types only when external events are allowed', async () => {
    const tree = await sourceTree()
    await writeFile(join(tree.root, 'server/listeners/listener.ts'), `export default defineListener({ name: 'external', event: 'app:event', handle: () => {} })`)

    const types = await generateEventRegistryTypes({ allowExternalEvents: true }, tree.context, tree.templateDir)

    expect(types).toContain('export type EventName = keyof EventsByName & string | (string & {})')
    expect(types).toContain('Name extends keyof EventsByName ? EventPayloadOf<EventsByName[Name]> : unknown')
  })

  it('generates listener payload and queued service assertions for strict app composition', async () => {
    const tree = await sourceTree()
    await Promise.all([
      writeFile(join(tree.root, 'server/events/event.ts'), transferEvent('root:event')),
      writeFile(join(tree.root, 'server/listeners/listener.ts'), queuedListener('listener', 'root:event')),
    ])

    const options = {
      queues: ['events'],
      queuedDeliveryContext: 'server/event-context.ts',
    }
    const [types, contracts] = await Promise.all([
      generateEventRegistryTypes(options, tree.context, tree.templateDir),
      generateEventRegistryContracts(options, tree.context, tree.templateDir),
    ])

    expect(types).not.toContain('AssertListenerPayload_listener_0')
    expect(contracts).toContain('AssertListenerPayload_listener_0')
    expect(contracts).toContain('AssertQueuedServices_listener_0')
    expect(contracts).toContain('AssertQueuedDeliveryContext')
    expect(contracts).toContain('QueuedDeliveryServices extends ListenerServicesOf')
    expect(contracts).toContain('createQueuedEventListenerContext')
  })

  it('generates a parser assertion when listener input is explicit', async () => {
    const tree = await sourceTree()
    await Promise.all([
      writeFile(join(tree.root, 'server/events/event.ts'), transferEvent('root:event')),
      writeFile(join(tree.root, 'server/listeners/listener.ts'), `export default defineListener({ name: 'listener', event: 'root:event', input: parser, handle: () => {} })`),
    ])

    const contracts = await generateEventRegistryContracts({}, tree.context, tree.templateDir)

    expect(contracts).toContain('AssertListenerInput_listener_0')
    expect(contracts).not.toContain('AssertListenerPayload_listener_0')
  })

  it('allows same-isolate deferred listeners for local request payloads', async () => {
    const tree = await sourceTree()
    await writeFile(join(tree.root, 'server/events/event.ts'), localEvent('request:event'))
    await writeFile(join(tree.root, 'server/listeners/listener.ts'), `export default defineListener({
      name: 'request-cleanup',
      event: 'request:event',
      execution: { _tag: 'deferred', failure: 'isolate' },
      handle: async () => {},
    })`)

    const plan = await buildEventRegistryPlan({}, tree.context, tree.templateDir)
    expect(plan.listeners[0]!.meta.execution).toEqual({ _tag: 'deferred', failure: 'isolate' })
  })

  it.each([
    {
      name: 'duplicate listener names',
      setup: async (tree: Awaited<ReturnType<typeof sourceTree>>) => {
        await writeFile(join(tree.root, 'server/events/event.ts'), transferEvent('root:event'))
        await writeFile(join(tree.root, 'server/listeners/one.ts'), queuedListener('duplicate', 'root:event'))
        await writeFile(join(tree.layer, 'server/listeners/two.ts'), queuedListener('duplicate', 'root:event'))
      },
      error: /Duplicate listener name/,
    },
    {
      name: 'unknown queues',
      setup: async (tree: Awaited<ReturnType<typeof sourceTree>>) => {
        await writeFile(join(tree.root, 'server/events/event.ts'), transferEvent('root:event'))
        await writeFile(join(tree.root, 'server/listeners/one.ts'), queuedListener('listener', 'root:event', 'missing'))
      },
      error: /Unknown queue/,
    },
    {
      name: 'local queued listeners',
      setup: async (tree: Awaited<ReturnType<typeof sourceTree>>) => {
        await writeFile(join(tree.root, 'server/events/event.ts'), localEvent('root:event'))
        await writeFile(join(tree.root, 'server/listeners/one.ts'), queuedListener('listener', 'root:event'))
      },
      error: /Local event .* cannot use queued/,
    },
  ])('fails the build for $name', async ({ setup, error }) => {
    const tree = await sourceTree()
    await setup(tree)
    await expect(buildEventRegistryPlan({ queues: ['events'], queuedDeliveryContext: 'server/event-context.ts' }, tree.context, tree.templateDir)).rejects.toThrow(error)
  })
})
