import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue'
import type {
  CfJobsBroadcastBatchProgressEvent,
  CfJobsBroadcastEnvelope,
  CfJobsBroadcastJobEvent,
} from '../../shared/broadcast'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { useRuntimeConfig } from '#app'
import {
  CF_JOBS_BROADCAST_DEFAULT_ROUTE,
  cfJobBatchChannel,
  cfJobChannel,
  cfJobQueueChannel,
  cfJobSiteChannel,
  cfJobUserChannel,
  isCfJobsBroadcastChannel,
} from '../../shared/broadcast'

export {
  cfJobBatchChannel,
  cfJobChannel,
  cfJobQueueChannel,
  cfJobSiteChannel,
  cfJobUserChannel,
}
export type {
  CfJobsBroadcastBatchProgressEvent,
  CfJobsBroadcastEnvelope,
  CfJobsBroadcastJobEvent,
}

export type CfJobsBroadcastStatus = 'idle' | 'connecting' | 'open' | 'closed'
export type CfJobWatchStatus = 'idle' | 'queued' | 'running' | 'retrying' | 'completed' | 'failed'

export type CfJobsBroadcastListener = (event: CfJobsBroadcastEnvelope) => void

export interface UseCfJobsBroadcastOptions {
  /** Defaults to `runtimeConfig.public.cfJobs.broadcast.route` or `/__cf-jobs/ws`. */
  route?: string
  reconnectDelay?: number
}

export interface UseCfJobsChannelOptions extends UseCfJobsBroadcastOptions {}

export interface UseCfJobsChannelReturn {
  status: Ref<CfJobsBroadcastStatus>
}

export interface CfJobsBroadcastBus {
  status: Ref<CfJobsBroadcastStatus>
  listen: (channel: string, listener: CfJobsBroadcastListener) => () => void
  subscribe: (channel: string) => void
  unsubscribe: (channel: string) => void
  close: () => void
}

interface Connection {
  url: string
  ws: WebSocket | null
  status: Ref<CfJobsBroadcastStatus>
  channels: Map<string, Set<CfJobsBroadcastListener>>
  refs: number
  stopped: boolean
  reconnect: ReturnType<typeof setTimeout> | null
  reconnectDelay: number
}

const registry = new Map<string, Connection>()

export function useCfJobsBroadcast(options: UseCfJobsBroadcastOptions = {}): CfJobsBroadcastBus {
  const idle = ref<CfJobsBroadcastStatus>('idle')
  if (!import.meta.client) {
    return {
      status: idle,
      listen: (_channel: string, _listener: CfJobsBroadcastListener) => () => {},
      subscribe: () => {},
      unsubscribe: () => {},
      close: () => {},
    }
  }

  const conn = acquire(resolveBroadcastUrl(options), options)
  onScopeDispose(() => release(conn.url))

  return {
    status: conn.status,
    listen(channel: string, listener: CfJobsBroadcastListener) {
      return addListener(conn, channel, listener)
    },
    subscribe(channel: string) {
      addChannel(conn, channel)
    },
    unsubscribe(channel: string) {
      removeChannel(conn, channel)
    },
    close() {
      release(conn.url)
    },
  }
}

export function useCfJobsChannel<T = unknown>(
  channel: MaybeRefOrGetter<string | null | undefined>,
  onEvent: (event: CfJobsBroadcastEnvelope<T>) => void,
  options: UseCfJobsChannelOptions = {},
): UseCfJobsChannelReturn {
  const status = ref<CfJobsBroadcastStatus>('idle')
  const bus = useCfJobsBroadcast(options)
  let stopListen: (() => void) | null = null
  let stopStatusWatch: (() => void) | null = null

  function detach() {
    stopListen?.()
    stopListen = null
    stopStatusWatch?.()
    stopStatusWatch = null
    status.value = 'closed'
  }

  function attach(next: string | null | undefined) {
    detach()
    if (!next || !isCfJobsBroadcastChannel(next))
      return
    stopListen = bus.listen(next, event => onEvent(event as CfJobsBroadcastEnvelope<T>))
    stopStatusWatch = watch(bus.status, s => (status.value = s), { immediate: true })
  }

  watch(() => toValue(channel), attach, { immediate: true })
  onScopeDispose(detach)

  return { status }
}

export interface UseCfJobOptions<T = unknown> extends UseCfJobsChannelOptions {
  onEvent?: (event: CfJobsBroadcastEnvelope<CfJobsBroadcastJobEvent>) => void
  onCompleted?: (event: CfJobsBroadcastJobEvent & { result?: T }) => void
  onFailed?: (event: CfJobsBroadcastJobEvent) => void
}

export interface UseCfJobReturn<T = unknown> {
  status: Ref<CfJobsBroadcastStatus>
  state: Ref<CfJobWatchStatus>
  events: Ref<Array<CfJobsBroadcastEnvelope<CfJobsBroadcastJobEvent>>>
  lastEvent: Ref<CfJobsBroadcastEnvelope<CfJobsBroadcastJobEvent> | null>
  result: Ref<T | null>
  error: Ref<string | null>
}

export function useCfJob<T = unknown>(
  jobId: MaybeRefOrGetter<string | null | undefined>,
  options: UseCfJobOptions<T> = {},
): UseCfJobReturn<T> {
  const state = ref<CfJobWatchStatus>('idle')
  const events = ref<Array<CfJobsBroadcastEnvelope<CfJobsBroadcastJobEvent>>>([])
  const lastEvent = ref<CfJobsBroadcastEnvelope<CfJobsBroadcastJobEvent> | null>(null)
  const result = shallowRef<T | null>(null)
  const error = ref<string | null>(null)

  watch(() => toValue(jobId), (id) => {
    events.value = []
    lastEvent.value = null
    result.value = null
    error.value = null
    state.value = id ? 'queued' : 'idle'
  }, { immediate: true })

  const { status } = useCfJobsChannel<CfJobsBroadcastJobEvent>(
    () => {
      const id = toValue(jobId)
      return id ? cfJobChannel(id) : null
    },
    (event) => {
      events.value.push(event)
      lastEvent.value = event
      options.onEvent?.(event)

      const data = event.data
      if (event.event === 'job.claimed') {
        state.value = 'running'
        return
      }
      if (event.event === 'job.released') {
        state.value = 'retrying'
        error.value = data.error ?? null
        return
      }
      if (event.event === 'job.failed') {
        state.value = 'failed'
        error.value = data.error ?? null
        options.onFailed?.(data)
        return
      }
      if (event.event === 'job.completed') {
        state.value = 'completed'
        result.value = (data.result ?? null) as T | null
        options.onCompleted?.(data as CfJobsBroadcastJobEvent & { result?: T })
      }
    },
    options,
  )

  return { status, state, events, lastEvent, result, error }
}

export interface UseCfJobBatchOptions extends UseCfJobsChannelOptions {
  onProgress?: (event: CfJobsBroadcastBatchProgressEvent) => void
}

export interface UseCfJobBatchReturn {
  status: Ref<CfJobsBroadcastStatus>
  progress: Ref<CfJobsBroadcastBatchProgressEvent | null>
  events: Ref<Array<CfJobsBroadcastEnvelope<CfJobsBroadcastBatchProgressEvent>>>
  finished: ComputedRef<boolean>
}

export function useCfJobBatch(
  batchId: MaybeRefOrGetter<string | null | undefined>,
  options: UseCfJobBatchOptions = {},
): UseCfJobBatchReturn {
  const progress = ref<CfJobsBroadcastBatchProgressEvent | null>(null)
  const events = ref<Array<CfJobsBroadcastEnvelope<CfJobsBroadcastBatchProgressEvent>>>([])
  const finished = computed(() => {
    const current = progress.value
    if (!current)
      return false
    return current.finishedAt != null || current.completed + current.failed >= current.total
  })

  watch(() => toValue(batchId), () => {
    progress.value = null
    events.value = []
  })

  const { status } = useCfJobsChannel<CfJobsBroadcastBatchProgressEvent>(
    () => {
      const id = toValue(batchId)
      return id ? cfJobBatchChannel(id) : null
    },
    (event) => {
      if (event.event !== 'batch.progress')
        return
      events.value.push(event)
      progress.value = event.data
      options.onProgress?.(event.data)
    },
    options,
  )

  return { status, progress, events, finished }
}

function acquire(url: string, options: UseCfJobsBroadcastOptions): Connection {
  let conn = registry.get(url)
  if (!conn) {
    conn = {
      url,
      ws: null,
      status: ref<CfJobsBroadcastStatus>('connecting'),
      channels: new Map(),
      refs: 0,
      stopped: false,
      reconnect: null,
      reconnectDelay: options.reconnectDelay ?? 2000,
    }
    registry.set(url, conn)
    connect(conn)
  }
  conn.refs += 1
  return conn
}

function release(url: string) {
  const conn = registry.get(url)
  if (!conn)
    return
  conn.refs -= 1
  if (conn.refs > 0)
    return

  conn.stopped = true
  if (conn.reconnect)
    clearTimeout(conn.reconnect)
  conn.ws?.close()
  registry.delete(url)
}

function connect(conn: Connection) {
  if (conn.stopped)
    return
  conn.status.value = 'connecting'
  const ws = new WebSocket(conn.url)
  conn.ws = ws

  ws.addEventListener('open', () => {
    conn.status.value = 'open'
    if (conn.channels.size > 0)
      sendCommand(conn, 'subscribe', [...conn.channels.keys()])
  })
  ws.addEventListener('message', (e) => {
    const envelope = parseEnvelope(e.data)
    if (!envelope)
      return
    const listeners = conn.channels.get(envelope.channel)
    if (!listeners)
      return
    for (const listener of listeners)
      listener(envelope)
  })
  ws.addEventListener('close', () => {
    conn.status.value = 'closed'
    conn.ws = null
    if (!conn.stopped)
      conn.reconnect = setTimeout(connect, conn.reconnectDelay, conn)
  })
  ws.addEventListener('error', () => ws.close())
}

function addListener(conn: Connection, channel: string, listener: CfJobsBroadcastListener): () => void {
  if (!addChannel(conn, channel))
    return () => {}
  conn.channels.get(channel)!.add(listener)
  return () => {
    const listeners = conn.channels.get(channel)
    listeners?.delete(listener)
    if (listeners && listeners.size === 0)
      removeChannel(conn, channel)
  }
}

function addChannel(conn: Connection, channel: string): boolean {
  if (!isCfJobsBroadcastChannel(channel))
    return false
  if (!conn.channels.has(channel)) {
    conn.channels.set(channel, new Set())
    sendCommand(conn, 'subscribe', [channel])
  }
  return true
}

function removeChannel(conn: Connection, channel: string) {
  if (!conn.channels.delete(channel))
    return
  sendCommand(conn, 'unsubscribe', [channel])
}

function sendCommand(conn: Connection, event: 'subscribe' | 'unsubscribe', channels: string[]) {
  if (conn.ws?.readyState !== WebSocket.OPEN)
    return
  conn.ws.send(JSON.stringify({ event, channels }))
}

function resolveBroadcastUrl(options: UseCfJobsBroadcastOptions): string {
  const config = useRuntimeConfig()
  const route = options.route
    ?? (config.public as { cfJobs?: { broadcast?: { route?: string } } }).cfJobs?.broadcast?.route
    ?? CF_JOBS_BROADCAST_DEFAULT_ROUTE
  if (route.startsWith('ws://') || route.startsWith('wss://'))
    return route
  const path = route.startsWith('/') ? route : `/${route}`
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${path}`
}

function parseEnvelope(input: unknown): CfJobsBroadcastEnvelope | null {
  if (typeof input !== 'string')
    return null
  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object')
      return null
    const envelope = parsed as CfJobsBroadcastEnvelope
    if (typeof envelope.channel !== 'string' || typeof envelope.event !== 'string')
      return null
    return envelope
  }
  catch {
    return null
  }
}
