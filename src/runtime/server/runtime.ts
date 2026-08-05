import type {
  AnyEventDefinition,
  AnyListenerDefinition,
  CommitEventPlanResult,
  DispatchReport,
  EventCommitUnitOfWork,
  EventDispatchContext,
  EventListenerEnvelope,
  EventObserver,
  EventPlan,
  GeneratedEventEntry,
  GeneratedEventRegistry,
  GeneratedListenerEntry,
  JsonValue,
  ListenerContext,
  ObserverFallback,
  QueueAdapterCallContext,
  QueuedDeliveryContext,
  QueuedListenerPublication,
  QueuePublicationOutcome,
  TransferEventDefinition,
} from './types'
import { eventRuntimeError, isEventRuntimeError } from './errors'

interface PreparedEvent {
  eventId: string
  eventName: string
  occurredAt: string
  definition: AnyEventDefinition
  payload: unknown
  encodedPayload?: JsonValue
  listeners: readonly GeneratedListenerEntry[]
}

interface RuntimeReportState {
  syncCompleted: string[]
  isolatedFailures: string[]
  deferredScheduled: string[]
  queued: string[]
  started: string[]
  failed: string[]
}

export interface GeneratedEventRuntime {
  dispatchEvent: (name: string, payload: unknown, context?: EventDispatchContext) => Promise<DispatchReport>
  planEvent: (name: string, payload: unknown, context?: EventDispatchContext) => Promise<EventPlan>
  commitEventPlan: (plan: EventPlan, unitOfWork: EventCommitUnitOfWork, context: EventDispatchContext) => Promise<CommitEventPlanResult>
  deliverQueuedListener: (envelope: EventListenerEnvelope, context: QueuedDeliveryContext) => Promise<void>
  handleQueuedListenerTerminalFailure: (envelope: EventListenerEnvelope, error: unknown, context: QueuedDeliveryContext) => Promise<void>
}

export interface GeneratedEventRuntimeOptions {
  observe?: EventObserver
  observerFallback?: ObserverFallback
}

export function createGeneratedEventRuntime(registry: GeneratedEventRegistry, options: GeneratedEventRuntimeOptions = {}): GeneratedEventRuntime {
  const plans = new WeakSet<EventPlan>()
  const committedPlans = new WeakSet<EventPlan>()

  const dispatchEvent = async (name: string, payload: unknown, context: EventDispatchContext = {}): Promise<DispatchReport> => {
    const eventId = context.eventId ?? crypto.randomUUID()
    const observe = createObserver([options.observe, context.observe], context.observerFallback ?? options.observerFallback)
    const state = emptyReportState()
    let listenerNames: readonly string[] = []
    return runObserved(eventId, name, observe, async () => {
      const prepared = await prepareEvent(registry, name, payload, { ...context, eventId })
      listenerNames = prepared.listeners.map(listener => listener.name)
      const deferred = prepared.listeners.filter(listener => listener.execution._tag === 'deferred')
      const queued = prepared.listeners.filter(listener => listener.execution._tag === 'queued')
      if (queued.some(listener => listener.execution._tag === 'queued' && listener.execution.publication === 'after-commit'))
        throw eventRuntimeError('AfterCommitRequired', `Event "${name}" requires planEvent() and commitEventPlan()`)
      if (queued.length > 0 && !context.eventId)
        throw eventRuntimeError('InvalidQueuedDelivery', `Queued event "${name}" requires a stable context.eventId`)
      if (queued.length > 0 && !context.queue)
        throw eventRuntimeError('QueueAdapterMissing', `Queued event "${name}" requires context.queue`)
      if (deferred.length > 0 && !context.waitUntil)
        throw eventRuntimeError('DeferredRuntimeMissing', `Deferred event "${name}" requires context.waitUntil`)

      await observe({ _tag: 'dispatch-started', eventId, eventName: name })
      await runSyncListeners(prepared, context, observe, state)

      const publications = buildPublications(prepared, queued)
      if (publications.length > 0)
        await publishImmediate(prepared, publications, context, observe, state)
      scheduleDeferred(prepared, deferred, context, observe, state)

      const report = toReport(prepared, state)
      await observe({
        _tag: 'dispatch-completed',
        eventId,
        eventName: name,
        listenerCount: prepared.listeners.length,
      })
      return report
    }, () => dispatchFailureDetail(state, listenerNames))
  }

  const planEvent = async (name: string, payload: unknown, context: EventDispatchContext = {}): Promise<EventPlan> => {
    const eventId = context.eventId ?? crypto.randomUUID()
    const observe = createObserver([options.observe, context.observe], context.observerFallback ?? options.observerFallback)
    return runObserved(eventId, name, observe, async () => {
      const prepared = await prepareEvent(registry, name, payload, { ...context, eventId })
      const queued = prepared.listeners.filter(listener => listener.execution._tag === 'queued')
      if (queued.length === 0 || queued.some(listener => listener.execution._tag === 'queued' && listener.execution.publication !== 'after-commit'))
        throw eventRuntimeError('EventPlanQueueMismatch', `Event "${name}" does not have a uniform after-commit queued publication plan`)
      if (prepared.listeners.some(listener => listener.execution._tag !== 'queued'))
        throw eventRuntimeError('EventPlanQueueMismatch', `Event "${name}" mixes after-commit queued and non-queued listeners; split the event contract in v1`)
      if (!context.eventId)
        throw eventRuntimeError('InvalidQueuedDelivery', `Queued event "${name}" requires a stable context.eventId`)

      const state = emptyReportState()
      await observe({ _tag: 'dispatch-started', eventId, eventName: name })
      await runSyncListeners(prepared, context, observe, state)
      const plan = Object.freeze({
        _tag: 'event-plan',
        planId: `${eventId}:${registry.manifestHash}`,
        eventId,
        eventName: name,
        occurredAt: prepared.occurredAt,
        syncCompleted: Object.freeze([...state.syncCompleted]),
        isolatedFailures: Object.freeze([...state.isolatedFailures]),
        deferred: Object.freeze(prepared.listeners.filter(listener => listener.execution._tag === 'deferred')),
        publications: buildPublications(prepared, queued),
        payload: snapshotPlannedPayload(prepared),
      } satisfies EventPlan)
      plans.add(plan)
      return plan
    })
  }

  const commitEventPlan = async (
    plan: EventPlan,
    unitOfWork: EventCommitUnitOfWork,
    context: EventDispatchContext,
  ): Promise<CommitEventPlanResult> => {
    const observe = createObserver([options.observe, context.observe], context.observerFallback ?? options.observerFallback)
    return runObserved(plan.eventId, plan.eventName, observe, async () => {
      if (!plans.has(plan) || committedPlans.has(plan))
        throw eventRuntimeError('EventPlanAlreadyCommitted', `Event plan "${plan.planId}" is invalid or already committed`)
      if (!context.queue)
        throw eventRuntimeError('QueueAdapterMissing', `Committing event "${plan.eventName}" requires context.queue`)
      if (plan.deferred.length > 0 && !context.waitUntil)
        throw eventRuntimeError('DeferredRuntimeMissing', `Committing event "${plan.eventName}" requires context.waitUntil`)

      const outcome = await unitOfWork.commit({
        planId: plan.planId,
        eventId: plan.eventId,
        eventName: plan.eventName,
        publications: plan.publications,
      })
      committedPlans.add(plan)
      if (outcome._tag === 'rolled-back') {
        await observe({
          _tag: 'transaction-rolled-back',
          eventId: plan.eventId,
          eventName: plan.eventName,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        })
        return {
          _tag: 'rolled-back',
          eventId: plan.eventId,
          eventName: plan.eventName,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        }
      }

      if (!sameDeliveryIds(plan.publications, outcome.receipt.deliveryIds))
        throw eventRuntimeError('EventPlanQueueMismatch', `Unit of work returned a mismatched staging receipt for plan "${plan.planId}"`)
      await dispatchCommitted(plan, plan.publications, context, observe)

      const prepared: PreparedEvent = {
        eventId: plan.eventId,
        eventName: plan.eventName,
        occurredAt: plan.occurredAt,
        definition: undefined as never,
        payload: plan.payload,
        listeners: plan.deferred,
      }
      const state: RuntimeReportState = {
        syncCompleted: [...plan.syncCompleted],
        isolatedFailures: [...plan.isolatedFailures],
        deferredScheduled: [],
        queued: plan.publications.map(publication => publication.envelope.listenerName),
        started: plan.publications.map(publication => publication.envelope.listenerName),
        failed: [],
      }
      scheduleDeferred(prepared, plan.deferred, context, observe, state)
      const report = toReport(prepared, state)
      await observe({
        _tag: 'dispatch-completed',
        eventId: plan.eventId,
        eventName: plan.eventName,
        listenerCount: plan.syncCompleted.length + plan.isolatedFailures.length + plan.deferred.length + plan.publications.length,
      })
      return { _tag: 'committed', report }
    })
  }

  const deliverQueuedListener = async (envelope: EventListenerEnvelope, context: QueuedDeliveryContext): Promise<void> => {
    const observe = createObserver([options.observe, context.observe], context.observerFallback ?? options.observerFallback)
    return runObserved(envelope.eventId, envelope.eventName, observe, async () => {
      const { listenerEntry, listener, listenerContext, parsed } = await prepareQueuedListener(registry, envelope, context)
      if (!listener.idempotency)
        throw eventRuntimeError('InvalidQueuedDelivery', `Queued listener "${listenerEntry.name}" has no idempotency definition`)
      await observe({ _tag: 'listener-started', eventId: envelope.eventId, eventName: envelope.eventName, listenerName: listenerEntry.name, execution: 'queued' })
      const key = await listener.idempotency.key(parsed, listenerContext)
      const result = await context.idempotency.run({
        key,
        deliveryId: envelope.deliveryId,
        eventId: envelope.eventId,
        eventName: envelope.eventName,
        listenerName: envelope.listenerName,
      }, async () => runListenerHandle(listener, parsed, listenerContext)).catch(async (cause) => {
        await observe({ _tag: 'listener-failed', eventId: envelope.eventId, eventName: envelope.eventName, listenerName: listenerEntry.name, execution: 'queued', isolated: false, error: cause })
        throw cause
      })
      if (result._tag === 'duplicate') {
        await observe({ _tag: 'listener-skipped', eventId: envelope.eventId, eventName: envelope.eventName, listenerName: listenerEntry.name, reason: 'duplicate' })
        return
      }
      await observe({ _tag: 'listener-completed', eventId: envelope.eventId, eventName: envelope.eventName, listenerName: listenerEntry.name, execution: 'queued' })
    })
  }

  const handleQueuedListenerTerminalFailure = async (envelope: EventListenerEnvelope, error: unknown, context: QueuedDeliveryContext): Promise<void> => {
    const observe = createObserver([options.observe, context.observe], context.observerFallback ?? options.observerFallback)
    const { listenerEntry, listener, listenerContext, parsed } = await prepareQueuedListener(registry, envelope, context)
    if (!listener.failed)
      return
    await listener.failed(parsed, listenerContext, error)
    await observe({
      _tag: 'listener-terminal-failure-handled',
      eventId: envelope.eventId,
      eventName: envelope.eventName,
      listenerName: listenerEntry.name,
    })
  }

  return { dispatchEvent, planEvent, commitEventPlan, deliverQueuedListener, handleQueuedListenerTerminalFailure }
}

async function prepareQueuedListener(
  registry: GeneratedEventRegistry,
  envelope: EventListenerEnvelope,
  context: QueuedDeliveryContext,
): Promise<{
  listenerEntry: GeneratedListenerEntry
  listener: AnyListenerDefinition
  listenerContext: ListenerContext
  parsed: unknown
}> {
  parseEventListenerEnvelope(envelope)
  const eventEntry = registry.events[envelope.eventName]
  const listenerEntry = registry.listenersByName[envelope.listenerName]
  if (!eventEntry || !listenerEntry || listenerEntry.event !== envelope.eventName || listenerEntry.execution._tag !== 'queued')
    throw eventRuntimeError('InvalidQueuedDelivery', 'Queued listener envelope does not match registry', { details: { envelope } })
  if (envelope.deliveryId !== deliveryId(envelope.eventId, envelope.listenerName))
    throw eventRuntimeError('InvalidQueuedDelivery', 'Queued listener envelope has an unstable deliveryId', { details: { envelope } })
  if (eventEntry.transport._tag !== 'transfer' || eventEntry.transport.version !== envelope.eventVersion)
    throw eventRuntimeError('InvalidQueuedDelivery', 'Queued listener envelope version is stale or event is not transferable', { details: { envelope } })

  const definition = await loadEventDefinition(eventEntry)
  const payload = parseEventPayload(definition, envelope.payload)
  const listener = await loadListenerDefinition(listenerEntry)
  const listenerContext = makeListenerContext(envelope, listenerEntry.name, context.services, context.attempt, context.signal)
  const parsed = parseListenerPayload(listener, payload, listenerEntry)
  return { listenerEntry, listener, listenerContext, parsed }
}

async function prepareEvent(
  registry: GeneratedEventRegistry,
  name: string,
  input: unknown,
  context: EventDispatchContext,
): Promise<PreparedEvent> {
  const entry = registry.events[name]
  if (!entry)
    throw eventRuntimeError('UnknownEvent', `Unknown event "${name}"`)
  const definition = await loadEventDefinition(entry)
  const payload = parseEventPayload(definition, input)
  const encodedPayload = definition.transport._tag === 'transfer' ? encodeEventPayload(definition, payload) : undefined
  return {
    eventId: context.eventId!,
    eventName: name,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
    definition,
    payload,
    ...(encodedPayload === undefined ? {} : { encodedPayload }),
    listeners: registry.listenersByEvent[name] ?? [],
  }
}

async function loadEventDefinition(entry: GeneratedEventEntry): Promise<AnyEventDefinition> {
  const definition = await entry.load().catch((cause) => {
    throw eventRuntimeError('EventContractImportFailure', `Failed to import event contract "${entry.name}"`, { cause })
  })
  if (definition.name !== entry.name || !sameEventTransport(definition, entry))
    throw eventRuntimeError('RegistryDrift', `Event contract "${entry.name}" does not match generated registry`)
  return definition
}

async function loadListenerDefinition(entry: GeneratedListenerEntry): Promise<AnyListenerDefinition> {
  const definition = await entry.load().catch((cause) => {
    throw eventRuntimeError('ListenerImportFailure', `Failed to import listener "${entry.name}"`, { cause })
  })
  if (
    definition.name !== entry.name
    || definition.event !== entry.event
    || !sameExecution(definition.execution, entry.execution)
    || Boolean(definition.idempotency) !== entry.hasIdempotency
    || Boolean(definition.failed) !== Boolean(entry.hasFailed)
  ) {
    throw eventRuntimeError('RegistryDrift', `Listener "${entry.name}" does not match generated registry`)
  }
  return definition
}

function sameEventTransport(definition: AnyEventDefinition, entry: GeneratedEventEntry): boolean {
  if (definition.transport._tag !== entry.transport._tag)
    return false
  if (definition.transport._tag === 'local' || entry.transport._tag === 'local')
    return definition.transport._tag === entry.transport._tag
  return definition.transport.version === entry.transport.version
    && (definition.transport.maxBytes ?? 65_536) === entry.transport.maxBytes
}

function sameExecution(actual: AnyListenerDefinition['execution'], expected: GeneratedListenerEntry['execution']): boolean {
  const normalized = actual ?? { _tag: 'sync' as const, failure: 'propagate' as const }
  if (normalized._tag !== expected._tag)
    return false
  if (normalized._tag === 'sync' && expected._tag === 'sync')
    return normalized.failure === expected.failure
  if (normalized._tag === 'deferred' && expected._tag === 'deferred')
    return normalized.failure === expected.failure
  if (normalized._tag !== 'queued' || expected._tag !== 'queued')
    return false
  return normalized.queue === expected.queue
    && normalized.publication === expected.publication
    && normalized.tries === expected.tries
    && sameNumberArray(normalized.backoff, expected.backoff)
}

function sameNumberArray(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]))
}

function parseEventPayload(definition: AnyEventDefinition, input: unknown): unknown {
  const parser = isTransferDefinition(definition) ? definition.codec : definition.input
  try {
    return parser.parse(input)
  }
  catch (cause) {
    throw eventRuntimeError('EventPayloadMismatch', `Payload does not match event contract "${definition.name}"`, { cause })
  }
}

function encodeEventPayload(definition: AnyEventDefinition, payload: unknown): JsonValue {
  if (!isTransferDefinition(definition))
    throw eventRuntimeError('EventPayloadEncodingFailure', `Local event "${definition.name}" cannot be encoded`)
  let encoded: JsonValue
  try {
    encoded = definition.codec.encode(payload)
    assertJsonValue(encoded)
  }
  catch (cause) {
    throw eventRuntimeError('EventPayloadEncodingFailure', `Failed to encode event "${definition.name}"`, { cause })
  }
  const bytes = new TextEncoder().encode(JSON.stringify(encoded)).byteLength
  const limit = definition.transport.maxBytes ?? 65_536
  if (bytes > limit)
    throw eventRuntimeError('EventPayloadTooLarge', `Encoded event "${definition.name}" is ${bytes} bytes; limit is ${limit}`, { details: { bytes, limit } })
  return encoded
}

async function runSyncListeners(
  prepared: PreparedEvent,
  context: EventDispatchContext,
  observe: EventObserver,
  state: RuntimeReportState,
): Promise<void> {
  for (const entry of prepared.listeners) {
    if (entry.execution._tag !== 'sync')
      continue
    state.started.push(entry.name)
    const completed = await runListener(entry, prepared, context.services, undefined, undefined, observe).catch((error) => {
      state.failed.push(entry.name)
      throw error
    })
    if (completed) {
      state.syncCompleted.push(entry.name)
    }
    else {
      state.isolatedFailures.push(entry.name)
      state.failed.push(entry.name)
    }
  }
}

async function runListener(
  entry: GeneratedListenerEntry,
  prepared: PreparedEvent,
  services: unknown,
  attempt: number | undefined,
  signal: AbortSignal | undefined,
  observe: EventObserver,
): Promise<boolean> {
  const execution = entry.execution
  await observe({ _tag: 'listener-started', eventId: prepared.eventId, eventName: prepared.eventName, listenerName: entry.name, execution: execution._tag })
  return Promise.resolve().then(async () => {
    const listener = await loadListenerDefinition(entry)
    const listenerContext = makeListenerContext(prepared, entry.name, services, attempt, signal)
    const payload = parseListenerPayload(listener, prepared.payload, entry)
    if (!(await shouldHandle(listener, payload, listenerContext))) {
      await observe({ _tag: 'listener-skipped', eventId: prepared.eventId, eventName: prepared.eventName, listenerName: entry.name, reason: 'condition' })
      return true
    }
    await runListenerHandle(listener, payload, listenerContext)
    await observe({ _tag: 'listener-completed', eventId: prepared.eventId, eventName: prepared.eventName, listenerName: entry.name, execution: execution._tag })
    return true
  }).catch(async (cause) => {
    const isolated = execution._tag === 'deferred' || (execution._tag === 'sync' && execution.failure === 'isolate')
    await observe({ _tag: 'listener-failed', eventId: prepared.eventId, eventName: prepared.eventName, listenerName: entry.name, execution: execution._tag, isolated, error: cause })
    if (!isolated)
      throw isEventRuntimeError(cause) ? cause : eventRuntimeError('ListenerFailure', `Listener "${entry.name}" failed`, { cause })
    return false
  })
}

function parseListenerPayload(listener: AnyListenerDefinition, payload: unknown, entry: GeneratedListenerEntry): unknown {
  if (!listener.input)
    return payload
  try {
    return listener.input.parse(payload)
  }
  catch (cause) {
    throw eventRuntimeError('ListenerPayloadMismatch', `Payload does not match listener "${entry.name}"`, { cause })
  }
}

async function shouldHandle(listener: AnyListenerDefinition, payload: unknown, context: ListenerContext): Promise<boolean> {
  return listener.shouldHandle ? listener.shouldHandle(payload, context) : true
}

async function runListenerHandle(listener: AnyListenerDefinition, payload: unknown, context: ListenerContext): Promise<void> {
  const middleware = listener.middleware ?? []
  let index = -1
  const run = async (nextIndex: number): Promise<void> => {
    if (nextIndex <= index)
      throw eventRuntimeError('ListenerFailure', 'Listener middleware called next() more than once')
    index = nextIndex
    const current = middleware[nextIndex]
    if (!current) {
      await listener.handle(payload, context)
      return
    }
    await current(payload, context, () => run(nextIndex + 1))
  }
  await run(0)
}

function buildPublications(prepared: PreparedEvent, listeners: readonly GeneratedListenerEntry[]): readonly QueuedListenerPublication[] {
  if (listeners.length === 0)
    return []
  if (!isTransferDefinition(prepared.definition) || prepared.encodedPayload === undefined)
    throw eventRuntimeError('InvalidQueuedDelivery', 'Queued listeners require a transfer event contract')
  const definition = prepared.definition
  const encodedPayload = freezeJsonValue(prepared.encodedPayload)
  return Object.freeze(listeners.map((listener) => {
    if (listener.execution._tag !== 'queued')
      throw eventRuntimeError('InvalidQueuedDelivery', `Listener "${listener.name}" is not queued`)
    const stableDeliveryId = deliveryId(prepared.eventId, listener.name)
    const envelope = Object.freeze({
      _tag: 'event-listener' as const,
      deliveryId: stableDeliveryId,
      eventId: prepared.eventId,
      eventName: prepared.eventName,
      eventVersion: definition.transport.version,
      listenerName: listener.name,
      occurredAt: prepared.occurredAt,
      payload: encodedPayload,
    })
    return Object.freeze({
      deliveryId: stableDeliveryId,
      queue: listener.execution.queue,
      envelope,
      ...(listener.execution.tries === undefined ? {} : { tries: listener.execution.tries }),
      ...(listener.execution.backoff === undefined ? {} : { backoff: Object.freeze([...listener.execution.backoff]) }),
    })
  }))
}

function snapshotPlannedPayload(prepared: PreparedEvent): unknown {
  if (!isTransferDefinition(prepared.definition) || prepared.encodedPayload === undefined)
    throw eventRuntimeError('EventPlanQueueMismatch', `Event plan "${prepared.eventName}" requires a transferable payload`)
  return freezeValue(parseEventPayload(prepared.definition, prepared.encodedPayload))
}

async function publishImmediate(
  prepared: PreparedEvent,
  publications: readonly QueuedListenerPublication[],
  context: EventDispatchContext,
  observe: EventObserver,
  state: RuntimeReportState,
): Promise<void> {
  const outcomes = await callQueueAdapter(publications, () => context.queue!.publishImmediate(publications, queueCallContext(context, observe)))
  await settleQueueOutcomes(prepared.eventId, prepared.eventName, publications, outcomes, 'immediate', observe, state)
}

async function dispatchCommitted(
  plan: EventPlan,
  publications: readonly QueuedListenerPublication[],
  context: EventDispatchContext,
  observe: EventObserver,
): Promise<void> {
  const outcomes = await callQueueAdapter(publications, () => context.queue!.dispatchCommitted(publications, queueCallContext(context, observe)))
  await settleQueueOutcomes(plan.eventId, plan.eventName, publications, outcomes, 'after-commit', observe)
}

async function callQueueAdapter(
  publications: readonly QueuedListenerPublication[],
  call: () => Promise<readonly QueuePublicationOutcome[]>,
): Promise<readonly QueuePublicationOutcome[]> {
  return await call().catch((error: unknown) => publications.map(publication => ({
    _tag: 'failed' as const,
    deliveryId: publication.deliveryId,
    queue: publication.queue,
    status: 'adapter-failed' as const,
    error,
  })))
}

async function settleQueueOutcomes(
  eventId: string,
  eventName: string,
  publications: readonly QueuedListenerPublication[],
  outcomes: readonly QueuePublicationOutcome[],
  publicationMode: 'immediate' | 'after-commit',
  observe: EventObserver,
  state?: RuntimeReportState,
): Promise<void> {
  const expected = new Map(publications.map(publication => [`${publication.deliveryId}\0${publication.queue}`, publication]))
  const byKey = new Map<string, QueuePublicationOutcome>()
  const contractErrors: unknown[] = []
  for (const outcome of outcomes) {
    const key = `${outcome.deliveryId}\0${outcome.queue}`
    if (!expected.has(key) || byKey.has(key)) {
      contractErrors.push(new Error(`Queue adapter returned an unexpected or duplicate outcome for ${outcome.deliveryId}`))
      continue
    }
    byKey.set(key, outcome)
  }

  const failures: unknown[] = [...contractErrors]
  for (const publication of publications) {
    state?.started.push(publication.envelope.listenerName)
    const key = `${publication.deliveryId}\0${publication.queue}`
    const outcome = byKey.get(key) ?? {
      _tag: 'failed' as const,
      deliveryId: publication.deliveryId,
      queue: publication.queue,
      status: 'adapter-failed' as const,
      error: new Error(`Queue adapter omitted outcome for ${publication.deliveryId}`),
    }
    if (outcome._tag === 'published') {
      state?.queued.push(publication.envelope.listenerName)
      await observe({ _tag: 'queue-published', eventId, eventName, listenerName: publication.envelope.listenerName, deliveryId: publication.deliveryId, queue: publication.queue, publication: publicationMode })
      continue
    }
    failures.push(outcome.error)
    state?.failed.push(publication.envelope.listenerName)
    await observe({
      _tag: 'queue-failed',
      eventId,
      eventName,
      listenerName: publication.envelope.listenerName,
      deliveryId: publication.deliveryId,
      queue: publication.queue,
      publication: publicationMode,
      status: outcome.status,
      error: outcome.error,
    })
  }

  if (failures.length > 0)
    throw eventRuntimeError('QueueDispatchFailure', `Queued listener publication failed for event "${eventName}"`, { cause: new AggregateError(failures, `Publication failures for ${eventName}`) })
}

function scheduleDeferred(
  prepared: PreparedEvent,
  entries: readonly GeneratedListenerEntry[],
  context: EventDispatchContext,
  observe: EventObserver,
  state: RuntimeReportState,
): void {
  for (const entry of entries) {
    const task = Promise.resolve(observe({ _tag: 'deferred-scheduled', eventId: prepared.eventId, eventName: prepared.eventName, listenerName: entry.name }))
      .then(() => runListener(entry, prepared, context.services, undefined, undefined, observe))
      .then(() => undefined)
    context.waitUntil!(task)
    state.deferredScheduled.push(entry.name)
  }
}

function makeListenerContext(
  event: Pick<PreparedEvent, 'eventId' | 'eventName' | 'occurredAt'> | EventListenerEnvelope,
  listenerName: string,
  services: unknown,
  attempt?: number,
  signal?: AbortSignal,
): ListenerContext {
  return {
    eventId: event.eventId,
    eventName: event.eventName,
    listenerName,
    occurredAt: event.occurredAt,
    services,
    ...(attempt === undefined ? {} : { attempt }),
    ...(signal === undefined ? {} : { signal }),
  }
}

function createObserver(observers: readonly (EventObserver | undefined)[], fallback?: ObserverFallback): EventObserver {
  const active = [...new Set(observers.filter((observer): observer is EventObserver => observer !== undefined))]
  return async (observation) => {
    if (active.length === 0) {
      if (observation._tag === 'listener-failed' || observation._tag === 'queue-failed' || observation._tag === 'dispatch-failed')
        await writeObserverConsole('[event-listeners]', observation)
      return
    }
    for (const observer of active) {
      await Promise.resolve().then(() => observer(observation)).catch(async (observerError) => {
        if (!fallback) {
          await writeObserverConsole('[event-listeners] observer failed', { observation, observerError })
          return
        }
        await Promise.resolve().then(() => fallback({ observation, observerError })).catch((fallbackError) => {
          return writeObserverConsole('[event-listeners] observer fallback failed', { observation, observerError, fallbackError })
        })
      })
    }
  }
}

async function writeObserverConsole(message: string, detail: unknown): Promise<void> {
  // stderr is the terminal fallback. A hostile console shim must not alter the
  // listener or producer outcome, and there is no further reporter to invoke.
  await Promise.resolve().then(() => console.error(message, detail)).catch(() => {
    // The terminal stderr fallback failed; no reporter remains, and reporting may
    // never alter the listener or producer outcome.
    return undefined
  })
}

async function runObserved<Output>(
  eventId: string,
  eventName: string,
  observe: EventObserver,
  effect: () => Promise<Output>,
  failureDetail?: () => Omit<Extract<Parameters<EventObserver>[0], { _tag: 'dispatch-failed' }>, '_tag' | 'eventId' | 'eventName' | 'error'>,
): Promise<Output> {
  return effect().catch(async (error) => {
    await observe({ _tag: 'dispatch-failed', eventId, eventName, error, ...failureDetail?.() })
    throw error
  })
}

function queueCallContext(context: EventDispatchContext, observe: EventObserver): QueueAdapterCallContext {
  return { transportContext: context.transportContext, observe, observerFallback: context.observerFallback }
}

function emptyReportState(): RuntimeReportState {
  return { syncCompleted: [], isolatedFailures: [], deferredScheduled: [], queued: [], started: [], failed: [] }
}

function dispatchFailureDetail(state: RuntimeReportState, listenerNames: readonly string[]) {
  const started = new Set([...state.started, ...state.deferredScheduled, ...state.queued])
  return {
    completed: Object.freeze([...state.syncCompleted]),
    failed: Object.freeze([...new Set(state.failed)]),
    deferredScheduled: Object.freeze([...state.deferredScheduled]),
    queued: Object.freeze([...state.queued]),
    notStarted: Object.freeze(listenerNames.filter(listener => !started.has(listener))),
  }
}

function toReport(prepared: Pick<PreparedEvent, 'eventId' | 'eventName'>, state: RuntimeReportState): DispatchReport {
  return { _tag: 'dispatched', eventId: prepared.eventId, eventName: prepared.eventName, ...state }
}

function deliveryId(eventId: string, listenerName: string): string {
  return `${eventId.length}:${eventId}:${listenerName}`
}

function sameDeliveryIds(expected: readonly QueuedListenerPublication[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length || new Set(actual).size !== actual.length)
    return false
  const actualIds = new Set(actual)
  return expected.every(publication => actualIds.has(publication.deliveryId))
}

export function parseEventListenerEnvelope(input: unknown): EventListenerEnvelope {
  if (!isPlainRecord(input))
    throw eventRuntimeError('InvalidQueuedDelivery', 'Invalid queued listener envelope')
  const allowed = new Set(['_tag', 'deliveryId', 'eventId', 'eventName', 'eventVersion', 'listenerName', 'occurredAt', 'payload'])
  if (Object.keys(input).some(key => !allowed.has(key))
    || input._tag !== 'event-listener'
    || !isNonEmptyString(input.deliveryId)
    || !isNonEmptyString(input.eventId)
    || !isNonEmptyString(input.eventName)
    || !isNonEmptyString(input.listenerName)
    || !Number.isInteger(input.eventVersion)
    || (input.eventVersion as number) < 1
    || !isIsoTimestamp(input.occurredAt)) {
    throw eventRuntimeError('InvalidQueuedDelivery', 'Invalid queued listener envelope')
  }
  try {
    assertJsonValue(input.payload)
  }
  catch (cause) {
    throw eventRuntimeError('InvalidQueuedDelivery', 'Queued listener envelope payload is not JSON', { cause })
  }
  return Object.freeze({
    _tag: 'event-listener',
    deliveryId: input.deliveryId,
    eventId: input.eventId,
    eventName: input.eventName,
    eventVersion: input.eventVersion as number,
    listenerName: input.listenerName,
    occurredAt: input.occurredAt,
    payload: freezeJsonValue(cloneJsonValue(input.payload as JsonValue)),
  })
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0
}

function isIsoTimestamp(input: unknown): input is string {
  if (typeof input !== 'string')
    return false
  const time = Date.parse(input)
  return Number.isFinite(time) && new Date(time).toISOString() === input
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (!value || typeof value !== 'object')
    return value
  if (Array.isArray(value))
    return value.map(cloneJsonValue)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]))
}

export function safeParseEventListenerEnvelope(input: unknown): { success: true, data: EventListenerEnvelope } | { success: false, error: unknown } {
  try {
    return { success: true, data: parseEventListenerEnvelope(input) }
  }
  catch (error) {
    return { success: false, error }
  }
}

function assertJsonValue(value: unknown, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('JSON numbers must be finite')
    return
  }
  if (typeof value !== 'object')
    throw new TypeError(`Value of type ${typeof value} is not JSON serializable`)
  if (seen.has(value))
    throw new TypeError('JSON payload contains a cycle')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const child of value)
      assertJsonValue(child, seen)
    seen.delete(value)
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError('JSON objects must be plain objects')
  for (const child of Object.values(value as Record<string, unknown>))
    assertJsonValue(child, seen)
  seen.delete(value)
}

function freezeJsonValue<Value extends JsonValue>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value))
      freezeJsonValue(child)
    Object.freeze(value)
  }
  return value
}

function freezeValue<Value>(value: Value, seen = new Set<object>()): Value {
  if (!value || typeof value !== 'object' || seen.has(value))
    return value
  seen.add(value)
  for (const child of Object.values(value))
    freezeValue(child, seen)
  return Object.freeze(value)
}

export function isPermanentQueuedDeliveryError(error: unknown): boolean {
  return isEventRuntimeError(error) && (
    error._tag === 'InvalidQueuedDelivery'
    || error._tag === 'EventPayloadMismatch'
    || error._tag === 'ListenerPayloadMismatch'
  )
}

function isTransferDefinition(definition: AnyEventDefinition): definition is TransferEventDefinition<string, any> {
  return definition.transport._tag === 'transfer'
}
