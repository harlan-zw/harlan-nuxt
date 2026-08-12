import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type WorkerSecretsResolution
  = | { _tag: 'missing', names: string[] }
    | { _tag: 'resolved', secrets: Record<string, string> }

export interface WorkerSecretsFileOptions<T> {
  secrets: Readonly<Record<string, string | null>>
  use: (path: string) => Promise<T> | T
}

type AsyncOutcome<T>
  = | { _tag: 'ok', value: T }
    | { _tag: 'error', error: unknown }

export function resolveWorkerSecrets(
  requiredNames: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): WorkerSecretsResolution {
  const names = [...new Set(requiredNames)]
  const missing = names.filter(name => environment[name] === undefined || environment[name] === '')
  if (missing.length > 0)
    return { _tag: 'missing', names: missing }

  return {
    _tag: 'resolved',
    secrets: Object.fromEntries(names.map(name => [name, environment[name]!])),
  }
}

function settle<T>(promise: Promise<T>): Promise<AsyncOutcome<T>> {
  return promise.then(
    value => ({ _tag: 'ok', value }),
    error => ({ _tag: 'error', error }),
  )
}

function throwFailures(errors: unknown[], message: string): never {
  if (errors.length === 1)
    throw errors[0]
  throw new AggregateError(errors, message)
}

async function writeWorkerSecretsFile(
  path: string,
  payload: string,
): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  const writeOutcome = await settle(handle.writeFile(payload, 'utf8'))
  const closeOutcome = await settle(handle.close())
  const failures = [writeOutcome, closeOutcome]
    .filter((outcome): outcome is Extract<AsyncOutcome<unknown>, { _tag: 'error' }> => outcome._tag === 'error')
    .map(outcome => outcome.error)
  if (failures.length === 0)
    return

  throwFailures(failures, 'Failed to write and clean up the Worker secrets file')
}

export async function withWorkerSecretsFile<T>(options: WorkerSecretsFileOptions<T>): Promise<T> {
  const payload = `${JSON.stringify(options.secrets)}\n`
  const directory = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-secrets-'))
  const path = join(directory, 'secrets.json')
  const writeOutcome = await settle(writeWorkerSecretsFile(path, payload))
  if (writeOutcome._tag === 'error') {
    const cleanupOutcome = await settle(rm(directory, { force: true, recursive: true }))
    const failures = cleanupOutcome._tag === 'error'
      ? [writeOutcome.error, cleanupOutcome.error]
      : [writeOutcome.error]
    throwFailures(failures, 'Failed to write and clean up the Worker secrets file')
  }

  const useOutcome = await settle(Promise.resolve().then(() => options.use(path)))
  const cleanupOutcome = await settle(rm(directory, { force: true, recursive: true }))
  const failures = [useOutcome, cleanupOutcome]
    .filter((outcome): outcome is Extract<AsyncOutcome<unknown>, { _tag: 'error' }> => outcome._tag === 'error')
    .map(outcome => outcome.error)
  if (failures.length > 0)
    throwFailures(failures, 'Worker deployment and secrets file cleanup failed')
  if (useOutcome._tag === 'error')
    throw useOutcome.error
  return useOutcome.value
}
