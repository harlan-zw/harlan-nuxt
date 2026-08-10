import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions } from '../types'
import type { EventStaticMeta } from './extract-event-meta'
import type { ListenerStaticMeta } from './extract-listener-meta'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { addTemplate, addTypeTemplate, resolveFiles } from '@nuxt/kit'
import { extractEventMeta } from './extract-event-meta'
import { extractListenerMeta } from './extract-listener-meta'

const SOURCE_EXTENSION_RE = /\.[cm]?[jt]sx?$/
const WINDOWS_SLASH_RE = /\\/g

export interface RegistrySourceContext {
  rootDir: string
  layerRoots: string[]
}

export interface EventBuildPlanEntry {
  file: string
  importPath: string
  meta: EventStaticMeta
}

export interface ListenerBuildPlanEntry {
  file: string
  importPath: string
  meta: ListenerStaticMeta
}

export interface EventRegistryBuildPlan {
  events: EventBuildPlanEntry[]
  listeners: ListenerBuildPlanEntry[]
  manifestHash: string
  allowExternalEvents: boolean
  queuedDeliveryContextImportPath?: string
}

export function installEventRegistryTemplates(options: ModuleOptions, nuxt: Nuxt, templateDir: string): void {
  const sourceContext = sourceContextFromNuxt(nuxt)
  const registryTemplate = addTemplate({
    filename: 'domain-events/registry.mjs',
    write: true,
    getContents: async () => generateEventRegistryTemplate(options, sourceContext, templateDir),
  })
  const serverTemplate = addTemplate({
    filename: 'domain-events/server.mjs',
    write: true,
    getContents: () => renderEventServerProxy(),
  })
  const typesTemplate = addTypeTemplate({
    filename: 'domain-events/registry.d.ts',
    getContents: async () => generateEventRegistryTypes(options, sourceContext, templateDir),
  }, { nuxt: true, nitro: true })
  const contractsTemplate = addTemplate({
    filename: 'domain-events/contracts.ts',
    write: true,
    getContents: async () => generateEventRegistryContracts(options, sourceContext, templateDir),
  })

  nuxt.hook('nitro:prepare:types' as never, (({ references }: { references: Array<{ path: string }> }) => {
    references.push({ path: contractsTemplate.dst })
  }) as never)

  // Nuxt reports template getContents failures as warnings and can otherwise
  // finish a production build without a registry. Validate once after every
  // module has contributed config so registration defects are fatal.
  nuxt.hook('modules:done', async () => {
    await buildEventRegistryPlan(options, sourceContext, templateDir)
  })

  nuxt.options.alias['#domain-events/server'] = serverTemplate.dst
  const nitro = ((nuxt.options as unknown as { nitro?: Record<string, any> }).nitro ??= {})
  nitro.alias ||= {}
  nitro.alias['#domain-events/server'] = serverTemplate.dst

  if (nuxt.options.dev) {
    nitro.externals ||= {}
    const inline = nitro.externals.inline
    const entries = Array.isArray(inline) ? inline : inline ? [inline] : []
    nitro.externals.inline = [...entries, resolve(templateDir)]
  }

  nuxt.hooks.hook('builder:watch' as never, (async (_event: string, path: string) => {
    if (!isWatchedEventPath(path, options, sourceContext))
      return
    await nuxt.callHook('builder:generateApp', {
      filter: template => template.dst === registryTemplate.dst || template.dst === serverTemplate.dst || template.dst === typesTemplate.dst || template.dst === contractsTemplate.dst,
    })
  }) as never)
}

export async function buildEventRegistryPlan(
  options: ModuleOptions,
  sourceContext: RegistrySourceContext,
  templateDir: string,
): Promise<EventRegistryBuildPlan> {
  const [eventFiles, listenerFiles] = await Promise.all([
    resolveSourceFiles(options.eventsDir ?? 'server/events', options.eventsPattern ?? '**/*.ts', options.eventsIgnore ?? [], options.scanLayers !== false, sourceContext),
    resolveSourceFiles(options.listenersDir ?? 'server/listeners', options.listenersPattern ?? '**/*.ts', options.listenersIgnore ?? [], options.scanLayers !== false, sourceContext),
  ])
  const [allEvents, allListeners] = await Promise.all([
    Promise.all(eventFiles.map(async file => ({
      file,
      importPath: toImportPath(templateDir, file),
      meta: extractEventMeta(await readFile(file, 'utf8'), file),
    }))),
    Promise.all(listenerFiles.map(async file => ({
      file,
      importPath: toImportPath(templateDir, file),
      meta: extractListenerMeta(await readFile(file, 'utf8'), file),
    }))),
  ])
  const events = allEvents.filter(entry => entry.meta.enabled)
  const listeners = allListeners.filter(entry => entry.meta.enabled)
  assertValidPlan(
    events,
    listeners,
    new Set(options.queues ?? []),
    options.requiredEvents ?? [],
    options.requiredListeners ?? [],
    options.allowEmptyEvents ?? [],
    options.allowExternalEvents === true,
    options.allowExternalQueues === true,
    Boolean(options.queuedDeliveryContext),
  )

  const hashInput = {
    events: events.map(entry => ({ file: entry.file, meta: entry.meta })),
    listeners: listeners.map(entry => ({ file: entry.file, meta: entry.meta })),
  }
  const manifestHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex').slice(0, 16)
  return {
    events,
    listeners,
    manifestHash,
    allowExternalEvents: options.allowExternalEvents === true,
    ...(options.queuedDeliveryContext
      ? { queuedDeliveryContextImportPath: toImportPath(templateDir, resolve(sourceContext.rootDir, options.queuedDeliveryContext)) }
      : {}),
  }
}

export async function generateEventRegistryTemplate(
  options: ModuleOptions,
  sourceContext: RegistrySourceContext,
  templateDir: string,
): Promise<string> {
  return renderEventRegistry(await buildEventRegistryPlan(options, sourceContext, templateDir))
}

export async function generateEventRegistryTypes(
  options: ModuleOptions,
  sourceContext: RegistrySourceContext,
  templateDir: string,
): Promise<string> {
  return renderEventRegistryTypes(await buildEventRegistryPlan(options, sourceContext, templateDir))
}

export async function generateEventRegistryContracts(
  options: ModuleOptions,
  sourceContext: RegistrySourceContext,
  templateDir: string,
): Promise<string> {
  return renderEventRegistryContracts(await buildEventRegistryPlan(options, sourceContext, templateDir))
}

export function renderEventRegistry(plan: EventRegistryBuildPlan): string {
  const eventLines = plan.events.map(entry => [
    `name: ${JSON.stringify(entry.meta.name)}`,
    `transport: ${JSON.stringify(entry.meta.transport)}`,
    `load: () => import(${JSON.stringify(entry.importPath)}).then(m => m.default)`,
  ]).map(fields => `  { ${fields.join(', ')} },`)
  const listenerLines = plan.listeners.map(entry => [
    `name: ${JSON.stringify(entry.meta.name)}`,
    `event: ${JSON.stringify(entry.meta.event)}`,
    `execution: ${JSON.stringify(entry.meta.execution)}`,
    ...(entry.meta.owner ? [`owner: ${JSON.stringify(entry.meta.owner)}`] : []),
    `hasIdempotency: ${entry.meta.hasIdempotency}`,
    `hasFailed: ${entry.meta.hasFailed}`,
    `load: () => import(${JSON.stringify(entry.importPath)}).then(m => m.default)`,
  ]).map(fields => `  { ${fields.join(', ')} },`)

  return [
    '/* Generated by @harlanzw/nuxt-domain-events. Do not edit. */',
    `import { createGeneratedEventRegistry, createGeneratedEventRuntime } from '@harlanzw/nuxt-domain-events/server'`,
    `import { observeEventListener, observeEventListenerFallback } from '#domain-events/observer'`,
    '',
    `export const manifestHash = ${JSON.stringify(plan.manifestHash)}`,
    'export const registry = createGeneratedEventRegistry({',
    '  manifestHash,',
    '  events: [',
    ...eventLines,
    '  ],',
    '  listeners: [',
    ...listenerLines,
    '  ],',
    '})',
    '',
    'const runtime = createGeneratedEventRuntime(registry, { observe: observeEventListener, observerFallback: observeEventListenerFallback })',
    'export { runtime }',
    'export const dispatchEvent = runtime.dispatchEvent',
    'export const planEvent = runtime.planEvent',
    'export const commitEventPlan = runtime.commitEventPlan',
    'export const deliverQueuedListener = runtime.deliverQueuedListener',
    'export const handleQueuedListenerTerminalFailure = runtime.handleQueuedListenerTerminalFailure',
    '',
  ].join('\n')
}

export function renderEventServerProxy(): string {
  return [
    '/* Generated by @harlanzw/nuxt-domain-events. Do not edit. */',
    'let runtimePromise',
    'function loadRuntime() {',
    '  if (runtimePromise)',
    '    return runtimePromise',
    '  const pending = import(\'./registry.mjs\').then(m => m.runtime)',
    '  runtimePromise = pending',
    '  return pending.catch((error) => {',
    '    if (runtimePromise === pending)',
    '      runtimePromise = undefined',
    '    throw error',
    '  })',
    '}',
    'export async function dispatchEvent(...args) { return (await loadRuntime()).dispatchEvent(...args) }',
    'export async function planEvent(...args) { return (await loadRuntime()).planEvent(...args) }',
    'export async function commitEventPlan(...args) { return (await loadRuntime()).commitEventPlan(...args) }',
    'export async function deliverQueuedListener(...args) { return (await loadRuntime()).deliverQueuedListener(...args) }',
    'export async function handleQueuedListenerTerminalFailure(...args) { return (await loadRuntime()).handleQueuedListenerTerminalFailure(...args) }',
    '',
  ].join('\n')
}

export function renderEventRegistryTypes(plan: EventRegistryBuildPlan): string {
  const eventTypes = plan.events.map(entry => `    typeof import(${JSON.stringify(entry.importPath)})['default'],`)
  const eventName = plan.allowExternalEvents
    ? 'keyof EventsByName & string | (string & {})'
    : 'keyof EventsByName & string'
  const eventPayload = plan.allowExternalEvents
    ? 'Name extends keyof EventsByName ? EventPayloadOf<EventsByName[Name]> : unknown'
    : 'EventPayloadOf<EventsByName[Name]>'
  return [
    '/* Generated by @harlanzw/nuxt-domain-events. Do not edit. */',
    `import type { CommitEventPlanResult, DispatchReport, EventCommitUnitOfWork, EventDispatchContext, EventPayloadOf, EventPlan, QueuedDeliveryContext, EventListenerEnvelope } from '@harlanzw/nuxt-domain-events/server'`,
    '',
    `declare module '#domain-events/server' {`,
    '  type EventDefinitions = readonly [',
    ...eventTypes,
    '  ]',
    `  type EventsByName = { readonly [Definition in EventDefinitions[number] as Definition['name']]: Definition }`,
    `  export type EventName = ${eventName}`,
    `  export type EventPayload<Name extends EventName> = ${eventPayload}`,
    '  export function dispatchEvent<Name extends EventName>(name: Name, payload: EventPayload<Name>, context?: EventDispatchContext): Promise<DispatchReport>',
    '  export function planEvent<Name extends EventName>(name: Name, payload: EventPayload<Name>, context?: EventDispatchContext): Promise<EventPlan>',
    '  export function commitEventPlan(plan: EventPlan, unitOfWork: EventCommitUnitOfWork, context: EventDispatchContext): Promise<CommitEventPlanResult>',
    '  export function deliverQueuedListener(envelope: EventListenerEnvelope, context: QueuedDeliveryContext): Promise<void>',
    '  export function handleQueuedListenerTerminalFailure(envelope: EventListenerEnvelope, error: unknown, context: QueuedDeliveryContext): Promise<void>',
    '}',
    '',
    'export {}',
    '',
  ].join('\n')
}

export function renderEventRegistryContracts(plan: EventRegistryBuildPlan): string {
  const eventNames = new Set(plan.events.map(entry => entry.meta.name))
  const eventTypes = plan.events.map(entry => `  typeof import(${JSON.stringify(entry.importPath)})['default'],`)
  const listenerInputAssertions = plan.listeners
    .filter(entry => entry.meta.hasInput)
    .map((entry, index) => `type AssertListenerInput_${safeTypeName(entry.meta.name)}_${index} = AssertTrue<typeof import(${JSON.stringify(entry.importPath)})['default'] extends { input: InputParser<any> } ? true : false>`)
  const listenerAssertions = plan.listeners
    .filter(entry => !entry.meta.hasInput && eventNames.has(entry.meta.event))
    .map((entry, index) => `type AssertListenerPayload_${safeTypeName(entry.meta.name)}_${index} = AssertTrue<typeof import(${JSON.stringify(entry.importPath)})['default'] extends ListenerDefinition<string, ${JSON.stringify(entry.meta.event)}, EventPayload<${JSON.stringify(entry.meta.event)}>, any> ? true : false>`)
  const queuedServiceAssertions = plan.queuedDeliveryContextImportPath
    ? plan.listeners
        .filter(entry => entry.meta.execution._tag === 'queued')
        .map((entry, index) => `type AssertQueuedServices_${safeTypeName(entry.meta.name)}_${index} = AssertTrue<QueuedDeliveryServices extends ListenerServicesOf<typeof import(${JSON.stringify(entry.importPath)})['default']> ? true : false>`)
    : []

  return [
    '/* Generated by @harlanzw/nuxt-domain-events. Do not edit. */',
    `import type { EventPayloadOf, InputParser, ListenerDefinition, QueuedDeliveryContext } from '@harlanzw/nuxt-domain-events/server'`,
    '',
    'type EventDefinitions = readonly [',
    ...eventTypes,
    ']',
    `type EventsByName = { readonly [Definition in EventDefinitions[number] as Definition['name']]: Definition }`,
    `type EventPayload<Name extends keyof EventsByName> = EventPayloadOf<EventsByName[Name]>`,
    'type AssertTrue<Value extends true> = Value',
    'type ListenerServicesOf<Definition> = Definition extends ListenerDefinition<string, string, any, infer Services> ? Services : never',
    ...(plan.queuedDeliveryContextImportPath
      ? [
          `type QueuedDeliveryContextResult = Awaited<ReturnType<typeof import(${JSON.stringify(plan.queuedDeliveryContextImportPath)})['createQueuedEventListenerContext']>>`,
          `type AssertQueuedDeliveryContext = AssertTrue<QueuedDeliveryContextResult extends QueuedDeliveryContext<any> ? true : false>`,
          `type QueuedDeliveryServices = QueuedDeliveryContextResult extends QueuedDeliveryContext<infer Services> ? Services : never`,
        ]
      : []),
    ...listenerInputAssertions,
    ...listenerAssertions,
    ...queuedServiceAssertions,
    '',
    'export {}',
    '',
  ].join('\n')
}

function safeTypeName(value: string): string {
  return value.replace(/[^\w$]/g, '_')
}

function assertValidPlan(
  events: EventBuildPlanEntry[],
  listeners: ListenerBuildPlanEntry[],
  queues: Set<string>,
  requiredEvents: string[],
  requiredListeners: string[],
  allowEmptyEvents: string[],
  allowExternalEvents: boolean,
  allowExternalQueues: boolean,
  hasQueuedDeliveryContext: boolean,
): void {
  assertUnique(events.map(entry => ({ name: entry.meta.name, file: entry.file })), 'event')
  assertUnique(listeners.map(entry => ({ name: entry.meta.name, file: entry.file })), 'listener')
  const eventsByName = new Map(events.map(entry => [entry.meta.name, entry]))
  const listenerNames = new Set(listeners.map(entry => entry.meta.name))
  const missingEvents = requiredEvents.filter(name => !eventsByName.has(name))
  const missingListeners = requiredListeners.filter(name => !listenerNames.has(name))
  if (missingEvents.length > 0)
    throw new Error(`Missing required event registration(s): ${missingEvents.join(', ')}`)
  if (missingListeners.length > 0)
    throw new Error(`Missing required listener registration(s): ${missingListeners.join(', ')}`)
  const unknownAllowedEmptyEvents = allowEmptyEvents.filter(name => !eventsByName.has(name))
  if (unknownAllowedEmptyEvents.length > 0)
    throw new Error(`Unknown allowEmptyEvents registration(s): ${unknownAllowedEmptyEvents.join(', ')}`)
  const publicationsByEvent = new Map<string, Set<string>>()
  const queuedListeners = listeners.filter(listener => listener.meta.execution._tag === 'queued')
  if (queuedListeners.length > 0 && !hasQueuedDeliveryContext)
    throw new Error(`Queued listener delivery requires domainEvents.queuedDeliveryContext; found: ${queuedListeners.map(listener => listener.meta.name).join(', ')}`)

  for (const listener of listeners) {
    const event = eventsByName.get(listener.meta.event)
    if (!event && !allowExternalEvents)
      throw new Error(`Unknown event "${listener.meta.event}" in listener ${listener.meta.name} (${listener.file})`)
    if (event?.meta.transport._tag === 'local' && listener.meta.execution._tag === 'queued')
      throw new Error(`Local event "${event.meta.name}" cannot use queued listener ${listener.meta.name}`)
    if (listener.meta.execution._tag !== 'queued')
      continue
    if (!allowExternalQueues && !queues.has(listener.meta.execution.queue))
      throw new Error(`Unknown queue "${listener.meta.execution.queue}" in listener ${listener.meta.name}`)
    const publications = publicationsByEvent.get(listener.meta.event) ?? new Set<string>()
    publications.add(listener.meta.execution.publication)
    publicationsByEvent.set(listener.meta.event, publications)
  }

  for (const [event, publications] of publicationsByEvent) {
    if (publications.size > 1)
      throw new Error(`Event "${event}" mixes immediate and after-commit queued listeners; split the event contract in v1`)
    if (publications.has('after-commit')) {
      const nonQueued = listeners.filter(listener => listener.meta.event === event && listener.meta.execution._tag !== 'queued')
      if (nonQueued.length > 0)
        throw new Error(`Event "${event}" mixes after-commit queued and non-queued listeners; split the event contract in v1: ${nonQueued.map(listener => listener.meta.name).join(', ')}`)
    }
  }

  if (!allowExternalEvents) {
    const listenedEvents = new Set(listeners.map(listener => listener.meta.event))
    const allowedEmptyEvents = new Set(allowEmptyEvents)
    const emptyEvents = events
      .map(event => event.meta.name)
      .filter(name => !listenedEvents.has(name) && !allowedEmptyEvents.has(name))
    if (emptyEvents.length > 0)
      throw new Error(`Event contract(s) have no listeners: ${emptyEvents.join(', ')}`)
  }
}

function assertUnique(entries: Array<{ name: string, file: string }>, kind: string): void {
  const seen = new Map<string, string>()
  for (const entry of entries) {
    const previous = seen.get(entry.name)
    if (previous)
      throw new Error(`Duplicate ${kind} name "${entry.name}": ${previous}, ${entry.file}`)
    seen.set(entry.name, entry.file)
  }
}

async function resolveSourceFiles(
  configuredDirs: string | string[],
  pattern: string,
  ignore: string[],
  scanLayers: boolean,
  context: RegistrySourceContext,
): Promise<string[]> {
  const roots = scanLayers ? context.layerRoots : [context.rootDir]
  const dirs = toArray(configuredDirs).flatMap((directory) => {
    if (isAbsolute(directory))
      return [directory]
    return roots.map(root => resolve(root, directory))
  })
  const files = await Promise.all(dirs.map(async (directory) => {
    if (!existsSync(directory))
      return []
    return resolveFiles(directory, pattern, { ignore })
  }))
  return canonicalUnique(files.flat()).sort()
}

function sourceContextFromNuxt(nuxt: Nuxt): RegistrySourceContext {
  const roots = [
    nuxt.options.rootDir,
    ...nuxt.options._layers.map(layer => layer.config.rootDir),
  ]
  return {
    rootDir: canonicalPath(nuxt.options.rootDir),
    layerRoots: canonicalUnique(roots),
  }
}

function isWatchedEventPath(path: string, options: ModuleOptions, context: RegistrySourceContext): boolean {
  const candidate = canonicalPath(isAbsolute(path) ? path : resolve(context.rootDir, path))
  const configured = [options.eventsDir ?? 'server/events', options.listenersDir ?? 'server/listeners']
  const roots = options.scanLayers === false ? [context.rootDir] : context.layerRoots
  return configured.some(dirs => toArray(dirs).some((directory) => {
    const targets = isAbsolute(directory) ? [canonicalPath(directory)] : roots.map(root => canonicalPath(resolve(root, directory)))
    return targets.some(target => candidate === target || candidate.startsWith(`${target}${sep}`))
  }))
}

function canonicalUnique(paths: string[]): string[] {
  return [...new Set(paths.map(canonicalPath))]
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute
}

function toImportPath(templateDir: string, file: string): string {
  const path = relative(templateDir, file).replace(WINDOWS_SLASH_RE, '/').replace(SOURCE_EXTENSION_RE, '')
  return path.startsWith('.') ? path : `./${path}`
}

function toArray<Value>(input: Value | Value[]): Value[] {
  return Array.isArray(input) ? input : [input]
}
