export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface InputParser<Output> {
  parse: (input: unknown) => Output
}

export interface TransferCodec<Payload> extends InputParser<Payload> {
  encode: (payload: Payload) => JsonValue
}

export interface LocalEventTransport {
  _tag: 'local'
}

export interface TransferEventTransport {
  _tag: 'transfer'
  version: number
  maxBytes?: number
}

export interface LocalEventDefinition<Name extends string, Payload> {
  name: Name
  transport: LocalEventTransport
  input: InputParser<Payload>
  enabled?: boolean
}

export interface TransferEventDefinition<Name extends string, Payload> {
  name: Name
  transport: TransferEventTransport
  codec: TransferCodec<Payload>
  enabled?: boolean
}

export type EventDefinition<Name extends string = string, Payload = unknown>
  = LocalEventDefinition<Name, Payload> | TransferEventDefinition<Name, Payload>

export type AnyEventDefinition = EventDefinition<string, any>
export type EventPayloadOf<Definition> = Definition extends EventDefinition<string, infer Payload> ? Payload : never

export type ListenerExecution
  = {
    _tag: 'sync'
    failure: 'propagate' | 'isolate'
  }
  | {
    _tag: 'deferred'
    failure: 'isolate'
  }
  | {
    _tag: 'queued'
    queue: string
    publication: 'immediate' | 'after-commit'
    tries?: number
    backoff?: readonly number[]
  }

export interface ListenerIdempotency<Payload> {
  key: (payload: Payload, context: ListenerContext) => string | Promise<string>
}

export interface ListenerContext<Services = unknown> {
  eventId: string
  eventName: string
  listenerName: string
  occurredAt: string
  services: Services
  attempt?: number
  signal?: AbortSignal
}

export type ListenerMiddleware<Payload, Services = unknown> = (
  payload: Payload,
  context: ListenerContext<Services>,
  next: () => Promise<void>,
) => Promise<void>

interface ListenerDefinitionBase<Name extends string, Event extends string, Payload, Services> {
  name: Name
  event: Event
  /** Omit to use the owning event contract parser. */
  input?: InputParser<Payload>
  owner?: string
  middleware?: Array<ListenerMiddleware<Payload, Services>>
  handle: (payload: Payload, context: ListenerContext<Services>) => void | Promise<void>
  /** A literal false removes this listener from the generated registry and bundle. */
  enabled?: boolean
}

export type ListenerDefinition<
  Name extends string = string,
  Event extends string = string,
  Payload = unknown,
  Services = unknown,
> = ListenerDefinitionBase<Name, Event, Payload, Services> & (
  | {
    /** Laravel-compatible default: serial, synchronous, propagating. */
    execution?: undefined
    shouldHandle?: (payload: Payload, context: ListenerContext<Services>) => boolean | Promise<boolean>
    idempotency?: never
    failed?: never
  }
  | {
    execution: Extract<ListenerExecution, { _tag: 'sync' | 'deferred' }>
    shouldHandle?: (payload: Payload, context: ListenerContext<Services>) => boolean | Promise<boolean>
    idempotency?: never
    failed?: never
  }
  | {
    execution: Extract<ListenerExecution, { _tag: 'queued' }>
    /** Producer-time conditional queueing is intentionally deferred in v1. */
    shouldHandle?: never
    /** Queued delivery is at-least-once, so every queued listener declares its durable key. */
    idempotency: ListenerIdempotency<Payload>
    /** Runs after durable terminal settlement. Failures remain visible in the job observer. */
    failed?: (payload: Payload, context: ListenerContext<Services>, error: unknown) => void | Promise<void>
  }
)

export type AnyListenerDefinition = ListenerDefinition<string, string, any, any>

export interface GeneratedEventEntry {
  name: string
  transport: LocalEventTransport | Required<TransferEventTransport>
  load: () => Promise<AnyEventDefinition>
}

export interface GeneratedListenerEntry {
  name: string
  event: string
  execution: ListenerExecution
  owner?: string
  hasIdempotency: boolean
  hasFailed?: boolean
  load: () => Promise<AnyListenerDefinition>
}

export interface GeneratedEventRegistry {
  manifestHash: string
  events: Readonly<Record<string, GeneratedEventEntry>>
  listenersByEvent: Readonly<Record<string, readonly GeneratedListenerEntry[]>>
  listenersByName: Readonly<Record<string, GeneratedListenerEntry>>
}

export interface EventListenerEnvelope {
  _tag: 'event-listener'
  deliveryId: string
  eventId: string
  eventName: string
  eventVersion: number
  listenerName: string
  occurredAt: string
  payload: JsonValue
}

export interface QueuedListenerPublication {
  deliveryId: string
  queue: string
  envelope: EventListenerEnvelope
  tries?: number
  backoff?: readonly number[]
}

export type QueuePublicationFailureStatus = 'not-dispatched' | 'failed' | 'state-failed' | 'adapter-failed'

export type QueuePublicationOutcome
  = {
    _tag: 'published'
    deliveryId: string
    queue: string
  }
  | {
    _tag: 'failed'
    deliveryId: string
    queue: string
    status: QueuePublicationFailureStatus
    error: unknown
  }

export interface QueueAdapterCallContext {
  /** Request, task, env, D1, and waitUntil state. Never serialized into the envelope. */
  transportContext?: unknown
  observe: EventObserver
  observerFallback?: ObserverFallback
}

export interface EventQueueAdapter {
  /** Atomically persist immediate durable jobs, then attempt queue transport. */
  publishImmediate: (
    publications: readonly QueuedListenerPublication[],
    context: QueueAdapterCallContext,
  ) => Promise<readonly QueuePublicationOutcome[]>
  /** Send transport messages for rows already committed by EventCommitUnitOfWork. */
  dispatchCommitted: (
    publications: readonly QueuedListenerPublication[],
    context: QueueAdapterCallContext,
  ) => Promise<readonly QueuePublicationOutcome[]>
}

export interface EventCommitInput {
  planId: string
  eventId: string
  eventName: string
  /** The unit of work must stage these durable rows in the same transaction as domain writes. */
  publications: readonly QueuedListenerPublication[]
}

export type EventCommitOutcome
  = {
    _tag: 'committed'
    receipt: {
      _tag: 'staged-event-listeners'
      deliveryIds: readonly string[]
    }
  }
  | { _tag: 'rolled-back', reason?: unknown }

export interface EventCommitUnitOfWork {
  /**
   * Owns the transaction. A committed result means domain writes and durable
   * publication rows committed atomically. A rolled-back result must leave no
   * publication evidence. Queue transport starts only after this resolves.
   */
  commit: (input: EventCommitInput) => Promise<EventCommitOutcome>
}

export interface ListenerIdempotencyAdapter {
  run: <Output>(
    input: { key: string, deliveryId: string, eventId: string, eventName: string, listenerName: string },
    effect: () => Promise<Output>,
  ) => Promise<{ _tag: 'executed', value: Output } | { _tag: 'duplicate' }>
}

export type EventObservation
  = { _tag: 'dispatch-started', eventId: string, eventName: string }
    | { _tag: 'dispatch-completed', eventId: string, eventName: string, listenerCount: number }
    | { _tag: 'listener-started', eventId: string, eventName: string, listenerName: string, execution: ListenerExecution['_tag'] }
    | { _tag: 'listener-completed', eventId: string, eventName: string, listenerName: string, execution: ListenerExecution['_tag'] }
    | { _tag: 'listener-skipped', eventId: string, eventName: string, listenerName: string, reason: 'condition' | 'duplicate' }
    | { _tag: 'listener-failed', eventId: string, eventName: string, listenerName: string, execution: ListenerExecution['_tag'], isolated: boolean, error: unknown }
    | { _tag: 'deferred-scheduled', eventId: string, eventName: string, listenerName: string }
    | { _tag: 'queue-published', eventId: string, eventName: string, listenerName: string, deliveryId: string, queue: string, publication: 'immediate' | 'after-commit' }
    | { _tag: 'queue-failed', eventId: string, eventName: string, listenerName: string, deliveryId: string, queue: string, publication: 'immediate' | 'after-commit', status: QueuePublicationFailureStatus, error: unknown }
    | { _tag: 'listener-terminal-failure-handled', eventId: string, eventName: string, listenerName: string }
    | { _tag: 'transaction-rolled-back', eventId: string, eventName: string, reason?: unknown }
    | {
      _tag: 'dispatch-failed'
      eventId: string
      eventName: string
      error: unknown
      completed?: readonly string[]
      failed?: readonly string[]
      deferredScheduled?: readonly string[]
      queued?: readonly string[]
      notStarted?: readonly string[]
    }

export type EventObserver = (observation: EventObservation) => void | Promise<void>
export type ObserverFallback = (input: { observation: EventObservation, observerError: unknown }) => void | Promise<void>

export interface EventDispatchContext<Services = unknown> {
  eventId?: string
  occurredAt?: string
  services?: Services
  queue?: EventQueueAdapter
  waitUntil?: (task: Promise<void>) => void
  observe?: EventObserver
  observerFallback?: ObserverFallback
  transportContext?: unknown
}

export interface QueuedDeliveryContext<Services = unknown> {
  services: Services
  attempt?: number
  idempotency: ListenerIdempotencyAdapter
  observe?: EventObserver
  observerFallback?: ObserverFallback
  transportContext?: unknown
  signal?: AbortSignal
}

export interface DispatchReport {
  _tag: 'dispatched'
  eventId: string
  eventName: string
  syncCompleted: string[]
  isolatedFailures: string[]
  deferredScheduled: string[]
  queued: string[]
}

export interface EventPlan {
  _tag: 'event-plan'
  planId: string
  eventId: string
  eventName: string
  occurredAt: string
  publications: readonly QueuedListenerPublication[]
}

export type CommitEventPlanResult
  = { _tag: 'committed', report: DispatchReport }
    | { _tag: 'rolled-back', eventId: string, eventName: string, reason?: unknown }
