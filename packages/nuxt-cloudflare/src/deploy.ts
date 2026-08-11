import { open } from 'node:fs/promises'

export type WorkerSecretsResolution
  = | { _tag: 'missing', names: string[] }
    | { _tag: 'resolved', secrets: Record<string, string> }

export interface WorkerSecretsFileResult {
  _tag: 'written'
  path: string
}

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

export async function writeWorkerSecretsFile(
  path: string,
  secrets: Readonly<Record<string, string>>,
): Promise<WorkerSecretsFileResult> {
  const handle = await open(path, 'wx', 0o600)
  await handle.writeFile(`${JSON.stringify(secrets)}\n`, 'utf8').finally(() => handle.close())
  return { _tag: 'written', path }
}
