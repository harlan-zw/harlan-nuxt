import { open, unlink } from 'node:fs/promises'

export type WorkerSecretsResolution
  = | { _tag: 'missing', names: string[] }
    | { _tag: 'resolved', secrets: Record<string, string> }

export interface WorkerSecretsFileOptions<T> {
  path: string
  secrets: Readonly<Record<string, string>>
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

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function throwFailures(errors: unknown[], message: string): never {
  if (errors.length === 1)
    throw errors[0]
  throw new AggregateError(errors, message)
}

async function removeWorkerSecretsFile(path: string): Promise<void> {
  const outcome = await settle(unlink(path))
  if (outcome._tag === 'error' && !isMissingFileError(outcome.error))
    throw outcome.error
}

async function writeWorkerSecretsFile(
  path: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const payload = `${JSON.stringify(secrets)}\n`
  const handle = await open(path, 'wx', 0o600)
  const writeOutcome = await settle(handle.writeFile(payload, 'utf8'))
  const closeOutcome = await settle(handle.close())
  const failures = [writeOutcome, closeOutcome]
    .filter((outcome): outcome is Extract<AsyncOutcome<unknown>, { _tag: 'error' }> => outcome._tag === 'error')
    .map(outcome => outcome.error)
  if (failures.length === 0)
    return

  const cleanupOutcome = await settle(removeWorkerSecretsFile(path))
  if (cleanupOutcome._tag === 'error')
    failures.push(cleanupOutcome.error)
  throwFailures(failures, 'Failed to write and clean up the Worker secrets file')
}

export async function withWorkerSecretsFile<T>(options: WorkerSecretsFileOptions<T>): Promise<T> {
  await writeWorkerSecretsFile(options.path, options.secrets)
  const useOutcome = await settle(Promise.resolve().then(() => options.use(options.path)))
  const cleanupOutcome = await settle(removeWorkerSecretsFile(options.path))
  const failures = [useOutcome, cleanupOutcome]
    .filter((outcome): outcome is Extract<AsyncOutcome<unknown>, { _tag: 'error' }> => outcome._tag === 'error')
    .map(outcome => outcome.error)
  if (failures.length > 0)
    throwFailures(failures, 'Worker deployment and secrets file cleanup failed')
  if (useOutcome._tag === 'error')
    throw useOutcome.error
  return useOutcome.value
}
