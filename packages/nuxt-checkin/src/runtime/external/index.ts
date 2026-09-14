import type { Check, CheckContext, CheckReport, ReportIdentity } from '../server/index'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { checkReport, defineCheck, fail, pass, runChecks, unavailable } from '../server/index'

export * from '../server/index'

export interface ExternalCheckEvent {
  rootDir: string
  env: Readonly<Record<string, string | undefined>>
  since: Date
  previous: Record<string, unknown> | null
  clock: () => Date
}
export type ExternalCheckContext = CheckContext<ExternalCheckEvent> & ExternalCheckEvent
export interface ExternalOptions {
  required: readonly string[]
  credentials?: Record<string, string | { env: string, files?: Array<{ path: string, key: string, section?: string }> }>
  identity?: Omit<ReportIdentity, 'deployment'> & { deploymentEnv: string, environmentEnv?: string }
  timeoutMs?: number
  totalTimeoutMs?: number
  save?: {
    dir: string
    dirEnv?: string
    stateFile?: string
    timestampKey?: string
    baseline?: 'latest' | 'daily'
    defaultWindowMs?: number
  }
}

export function defineExternalCheck(check: { id: string, run: (context: ExternalCheckContext) => ReturnType<Check['run']> }): Check<ExternalCheckEvent> {
  return defineCheck({ id: check.id, run: (context) => {
    if (!context.event)
      return unavailable('External check context is unavailable.')
    return check.run({ ...context, ...context.event })
  } })
}

export async function runExternalChecks(checks: readonly Check<ExternalCheckEvent>[], options: ExternalOptions, input: Partial<ExternalCheckEvent> & { now?: Date } = {}): Promise<{ report: CheckReport, exitCode: number }> {
  const clock = input.clock ?? (() => new Date())
  const now = input.now ?? clock()
  const env = input.env ?? process.env
  const event: ExternalCheckEvent = { rootDir: input.rootDir ?? process.cwd(), env, since: input.since ?? new Date(now.getTime() - (options.save?.defaultWindowMs ?? 86_400_000)), previous: input.previous ?? null, clock }
  const credentials: Record<string, string> = {}
  for (const [key, source] of Object.entries(options.credentials ?? {})) {
    const value = await readCheckCredential(source, event)
    if (value)
      credentials[key] = value
  }
  const identity = options.identity ? { site: options.identity.site, environment: env[options.identity.environmentEnv ?? ''] ?? options.identity.environment, deployment: env[options.identity.deploymentEnv] ?? '' } : undefined
  const report = await runChecks(checks, { event, now, credentials, identity: identity?.deployment ? identity : undefined, required: options.required, timeoutMs: options.timeoutMs, totalTimeoutMs: options.totalTimeoutMs })
  return { report, exitCode: report.coverage !== 'complete' ? 2 : report.severity === 'pass' ? 0 : 1 }
}

interface RequestDependencies { request?: typeof fetch, clock?: () => Date }
export interface HttpCheckOptions {
  id: string
  url: string
  status?: number
  includes?: string
  maxBytes?: number
}
export interface ReportCheckOptions extends Omit<HttpCheckOptions, 'status' | 'includes'> {
  tokenEnv?: string
  deploymentEnv: string
  site: string
  environment: string
  environmentEnv?: string
  authHeader?: 'Authorization' | 'Cookie' | 'x-api-key'
  required: readonly string[]
  maxAgeMs: number
}
function checkUrl(url: string): string {
  const value = new URL(url)
  if (value.protocol !== 'https:' || value.username || value.password)
    throw new TypeError('External check URL must use HTTPS without credentials.')
  return value.href
}
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new TypeError('Response byte limit must be a positive integer.')
  const reader = response.body?.getReader()
  if (!reader)
    return ''
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      length += value.byteLength
      if (length > maxBytes)
        throw new Error('Response exceeds its byte limit.')
      chunks.push(value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks))
  }
  finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
export function defineHttpCheck(options: HttpCheckOptions, dependencies: RequestDependencies = {}): Check<ExternalCheckEvent> {
  const url = checkUrl(options.url)
  return defineExternalCheck({ id: options.id, async run(context) {
    const response = await (dependencies.request ?? fetch)(url, { signal: context.signal, redirect: 'error' })
    if (response.status !== (options.status ?? 200)) {
      await response.body?.cancel()
      return fail('HTTP status does not match.', { status: response.status })
    }
    const body = await readBoundedResponseText(response, options.maxBytes ?? 2_097_152)
    return options.includes && !body.includes(options.includes) ? fail('HTTP response is missing expected content.') : pass({ status: response.status })
  } })
}
export function defineReportCheck(options: ReportCheckOptions, dependencies: RequestDependencies = {}): Check<ExternalCheckEvent> {
  const url = checkUrl(options.url)
  return defineExternalCheck({ id: options.id, async run(context) {
    const token = options.tokenEnv ? context.env[options.tokenEnv] : undefined
    const deployment = context.env[options.deploymentEnv]
    const environment = options.environmentEnv ? context.env[options.environmentEnv] ?? options.environment : options.environment
    if ((options.tokenEnv && !token) || !deployment)
      return unavailable('Report credential or expected deployment is unavailable.')
    const header = options.authHeader ?? 'Authorization'
    const response = await (dependencies.request ?? fetch)(url, { signal: context.signal, redirect: 'error', headers: token ? { [header]: header === 'Authorization' ? `Bearer ${token}` : token } : undefined })
    if (response.status !== 200) {
      await response.body?.cancel()
      return unavailable(`Check report returned HTTP ${response.status}.`)
    }
    const body: unknown = JSON.parse(await readBoundedResponseText(response, options.maxBytes ?? 2_097_152))
    return checkReport(body, { identity: { site: options.site, environment, deployment }, required: options.required, maxAgeMs: options.maxAgeMs, now: (dependencies.clock ?? context.clock)() })
  } })
}

/** Run a read-only collector with the check's cancellation and output limits. */
export function runCheckCommand(context: Pick<ExternalCheckContext, 'rootDir' | 'signal' | 'env'>, command: string, args: readonly string[], options: { maxBytes?: number } = {}): Promise<{ _tag: 'Ok', stdout: string, stderr: string } | { _tag: 'Err', reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: context.rootDir, env: context.env, signal: context.signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let size = 0
    let exceeded = false
    const append = (chunk: Buffer, output: 'stdout' | 'stderr') => {
      size += chunk.byteLength
      if (size > (options.maxBytes ?? 2_097_152)) {
        exceeded = true
        child.kill('SIGKILL')
        return
      }
      if (output === 'stdout')
        stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
    child.on('error', () => resolve({ _tag: 'Err', reason: 'Check command could not complete.' }))
    child.on('close', code => resolve(exceeded ? { _tag: 'Err', reason: 'Check command exceeded its output limit.' } : code === 0 ? { _tag: 'Ok', stdout, stderr } : { _tag: 'Err', reason: 'Check command failed.' }))
  })
}

/** Read a named runtime credential without adding values to build configuration. */
export async function readCheckCredential(source: NonNullable<ExternalOptions['credentials']>[string], context: Pick<ExternalCheckEvent, 'rootDir' | 'env'>): Promise<string | undefined> {
  const name = typeof source === 'string' ? source : source.env
  if (context.env[name]?.trim())
    return context.env[name]!.trim()
  if (typeof source === 'string')
    return undefined
  for (const file of source.files ?? []) {
    const path = file.path.startsWith('~/') ? resolve(context.env.HOME ?? homedir(), file.path.slice(2)) : resolve(context.rootDir, file.path)
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return undefined
      throw error
    })
    if (text === undefined)
      continue
    let section: string | undefined
    for (const line of text.split(/\r?\n/)) {
      const heading = line.trim().match(/^\[([^\]]+)\]$/)
      if (heading) {
        section = heading[1]
        continue
      }
      const match = line.trim().replace(/^export\s+/, '').match(/^([\w.-]+)\s*=(.*)$/)
      if (!match || match[1] !== file.key || (file.section !== undefined && section !== file.section))
        continue
      const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
      if (value)
        return value
    }
  }
  return undefined
}
