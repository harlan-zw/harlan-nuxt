// Jev transport over the Cloudflare /ai/run endpoint. Failures surface as
// values (tagged Err), never throws, per the platform rule: every failure
// takes the safe direction.
//
// Response envelope, measured live: Cloudflare wraps twice. The System One
// result sits at `result.result` inside `{ success, result }`. Any 2xx body
// without an `answers` object is a failure, not an answer.
import type { Entry, JevModelResult, Questions, SystemOneRequest, SystemOneResult } from './questions'
import { validateAnswers } from './questions'

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const DEFAULT_JEV_MODEL = 'typesafe/jev'
export const DEFAULT_JEV_TIMEOUT_MS = 8000

export type JevFailure
  = | { readonly _tag: 'Http', readonly status: number, readonly message: string, readonly requestId?: string, readonly details?: unknown }
    | { readonly _tag: 'Invalid', readonly message: string, readonly body?: unknown, readonly requestId?: string }
    | { readonly _tag: 'Network', readonly message: string }
    | { readonly _tag: 'Timeout', readonly message: string }

export type JevResult<Q extends Questions = Questions>
  = | { readonly _tag: 'Ok', readonly result: SystemOneResult<Q> }
    | { readonly _tag: 'Err', readonly failure: JevFailure }

export type JevOk<Q extends Questions = Questions> = Extract<JevResult<Q>, { _tag: 'Ok' }>

export function jevClientOK<Q extends Questions = Questions>(result: JevResult<Q>): result is JevOk<Q> {
  return result._tag === 'Ok'
}

export interface JevHttpClientOptions {
  apiToken: string
  accountId: string
  gatewayId?: string
  /** Default `typesafe/jev`. Pin via config once bands are tuned. */
  model?: string
  /** Extra attempts after HTTP 429 and 529. Default 2. */
  retries?: number
  /** Seconds for `cf-aig-cache-ttl`; 0 omits the header. Default 0. */
  cacheTtl?: number
  /** One window across every attempt and backoff, in milliseconds. Default 8000. */
  timeoutMs?: number
  fetcher?: Fetcher
  baseURL?: string
}

export function createJevHttpClient(options: JevHttpClientOptions) {
  const baseURL = (options.baseURL ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')
  const model = options.model ?? DEFAULT_JEV_MODEL
  const retries = options.retries ?? 2
  const cacheTtl = Math.max(0, Math.floor(options.cacheTtl ?? 0))
  const timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS
  const gatewayId = options.gatewayId
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
  const url = `${baseURL}/accounts/${options.accountId}/ai/run`

  return {
    async systemOne<const Q extends Questions>(req: SystemOneRequest<Q>): Promise<JevResult<Q>> {
      const problem = requestProblem(req.questions)
      if (problem !== null)
        return { _tag: 'Err', failure: { _tag: 'Invalid', message: problem } }
      return send(req.state, req.questions, req.model) as unknown as JevResult<Q>
    },
  }

  async function send(state: Entry, questions: Questions, requestModel: string | undefined): Promise<JevResult<Questions>> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${options.apiToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(cacheTtl > 0 ? { 'cf-aig-cache-ttl': String(cacheTtl) } : {}),
      ...(gatewayId === undefined || gatewayId === '' ? {} : { 'cf-aig-gateway-id': gatewayId }),
    }
    const body = JSON.stringify({ model: requestModel ?? model, input: { state, questions } })

    // One deadline across the whole attempt+backoff window: the signal aborts
    // an in-flight fetch and cancels a pending backoff sleep alike.
    const deadline = AbortSignal.timeout(timeoutMs)

    let res: Response
    try {
      res = await fetcher(url, { method: 'POST', headers, body, signal: deadline })
      for (let attempted = 0; (res.status === 429 || res.status === 529) && attempted < retries; attempted++) {
        await sleep(backoffMilliseconds(res, attempted), deadline)
        res = await fetcher(url, { method: 'POST', headers, body, signal: deadline })
      }
    }
    catch (error: unknown) {
      return { _tag: 'Err', failure: failureFromError(error) }
    }

    const parsed = await parseBody(res)
    if (!res.ok) {
      return {
        _tag: 'Err',
        failure: {
          _tag: 'Http',
          status: res.status,
          message: `${res.status} ${describeBody(parsed)}`,
          requestId: res.headers.get('cf-ray') ?? undefined,
          details: parsed,
        },
      }
    }

    const unwrapped = unwrap(parsed, res)
    if (unwrapped._tag === 'Err')
      return { _tag: 'Err', failure: unwrapped.failure }

    const invalid = validateAnswers(questions, unwrapped.result.answers as Record<string, unknown>)
    if (invalid !== null)
      return { _tag: 'Err', failure: { _tag: 'Invalid', message: invalid } }
    return { _tag: 'Ok', result: unwrapped.result as SystemOneResult<Questions> }
  }
}

function requestProblem(questions: Questions): string | null {
  if (Object.keys(questions).length === 0)
    return 'At least one question is required.'
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'score' && !(q.criteria.length >= 2 && q.criteria.length <= 10))
      return `Score question "${name}" needs 2 to 10 levels.`
    if (q.type === 'choice') {
      const count = Object.keys(q.criteria ?? {}).length
      if (!(count >= 2 && count <= 255))
        return `Choice question "${name}" needs 2 to 255 options.`
    }
  }
  return null
}

function failureFromError(error: unknown): JevFailure {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return { _tag: 'Timeout', message: 'The jev request window expired.' }
  return { _tag: 'Network', message: error instanceof Error ? error.message : String(error) }
}

// Cloudflare answers REST calls with `{ success, errors, result }` and, on
// /ai/run, wraps the model answer once more inside `{ state, result,
// gatewayMetadata }`. The System One result with its `answers` must come out,
// or the call failed. A 2xx failure keeps its wire provenance: the raw body
// and the ray, so throwing callers can log what Cloudflare actually sent.
function unwrap(parsed: unknown, res: Response): { _tag: 'Ok', result: SystemOneResult } | { _tag: 'Err', failure: { readonly _tag: 'Invalid', readonly message: string, readonly body?: unknown, readonly requestId?: string } } {
  let value = parsed
  if (isEnvelope(value)) {
    const envelope = value as { success: boolean, errors?: unknown, result?: unknown }
    if (!envelope.success)
      return { _tag: 'Err', failure: { _tag: 'Invalid', message: `cf envelope failed: ${describeBody(envelope.errors ?? envelope)}`, body: parsed, requestId: rayOf(res) } }
    value = envelope.result ?? parsed
  }
  if (isRunWrapper(value))
    value = (value as JevModelResult).result
  if (typeof value !== 'object' || value === null || typeof (value as { answers?: unknown }).answers !== 'object' || (value as { answers?: unknown }).answers === null)
    return { _tag: 'Err', failure: { _tag: 'Invalid', message: `response carries no answers object: ${describeBody(parsed)}`, body: parsed, requestId: rayOf(res) } }
  const result = value as SystemOneResult
  // A model response may omit usage in full or in part. Zero the gaps, so no
  // caller downstream of the client ever reads `usage` off an undefined.
  return { _tag: 'Ok', result: { ...result, usage: normalizeUsage(result.usage) } }
}

function normalizeUsage(usage: { input_tokens?: number, output_tokens?: number } | undefined): { input_tokens: number, output_tokens: number } {
  return {
    input_tokens: tokenCount(usage?.input_tokens),
    output_tokens: tokenCount(usage?.output_tokens),
  }
}

function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function rayOf(res: Response): string | undefined {
  return res.headers.get('cf-ray') ?? undefined
}

function isEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'success' in value
}

function isRunWrapper(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'state' in value && 'result' in value
}

function backoffMilliseconds(res: Response, attempted: number): number {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter !== null && Number.isFinite(Number(retryAfter)))
    return Math.max(0, Number(retryAfter)) * 1000
  return 500 * 2 ** attempted
}

function sleep(milliseconds: number, deadline: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const expire = () => reject(new DOMException('The jev request window expired.', 'TimeoutError'))
    if (deadline.aborted) {
      expire()
      return
    }
    const timer = setTimeout(() => {
      deadline.removeEventListener('abort', expire)
      resolve()
    }, milliseconds)
    deadline.addEventListener('abort', () => {
      clearTimeout(timer)
      expire()
    }, { once: true })
  })
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch((err: unknown) => {
    // A body that cannot be read still has a status; surface the read failure
    // for logs and treat the body as empty.
    console.warn('jev: response body read failed', err instanceof Error ? err.message : err)
    return ''
  })
  if (!text)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

function describeBody(body: unknown): string {
  if (typeof body === 'string')
    return body
  if (typeof body !== 'object' || body === null)
    return '(no body)'
  const { error, message, detail } = body as Record<string, unknown>
  const m = error ?? message ?? detail
  if (typeof m === 'string')
    return m
  return JSON.stringify(body).slice(0, 200)
}

export type JevHttpClient = ReturnType<typeof createJevHttpClient>
