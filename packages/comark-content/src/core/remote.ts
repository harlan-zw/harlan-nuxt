import type { GitRepository } from '../config'
import type { Result } from '../runtime/types'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { err, ok, sourceError } from './result'

export interface RemoteSource {
  repository: GitRepository
  include: string
  exclude?: string | string[]
  prefix?: string
}

type Command = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<void>

const runCommand: Command = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: options.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let error = ''
  child.stderr.on('data', chunk => error += chunk)
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || `${command} exited with ${code}.`)))
})

function repositoryDetails(repository: GitRepository) {
  return typeof repository === 'string'
    ? { url: repository, reference: undefined, token: undefined }
    : { url: repository.url, reference: repository.tag ?? repository.branch, token: repository.auth?.token }
}

export async function prepareRemoteSource(source: RemoteSource, cacheRoot: string, command: Command = runCommand): Promise<Result<string>> {
  const repository = repositoryDetails(source.repository)
  const key = createHash('sha256').update(repository.url).update('\0').update(repository.reference ?? 'HEAD').digest('hex').slice(0, 20)
  const target = join(cacheRoot, key)
  const temporary = join(cacheRoot, `${key}.${randomUUID()}.next`)
  const previous = join(cacheRoot, `${key}.${randomUUID()}.previous`)
  await mkdir(dirname(temporary), { recursive: true })
  const args = ['clone', '--depth', '1', '--single-branch']
  if (repository.reference)
    args.push('--branch', repository.reference)
  args.push(repository.url, temporary)
  const env = repository.token
    ? {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repository.token}`,
      }
    : process.env
  const clone = (cloneEnv: NodeJS.ProcessEnv) => command('git', args, { env: cloneEnv })
    .then(() => ok(undefined), cause => err(cause))
  let cloned = await clone(env)
  if (cloned._tag === 'Err' && repository.token) {
    await rm(temporary, { recursive: true, force: true })
    cloned = await clone(process.env)
  }
  if (cloned._tag === 'Err') {
    await rm(temporary, { recursive: true, force: true })
    return err(sourceError('SourceError', repository.url, 1, 1, 'Could not refresh the remote Markdown source.', cloned.error))
  }
  try {
    await rename(target, previous).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error))
    await rename(temporary, target)
    await rm(previous, { recursive: true, force: true })
    return ok(target)
  }
  catch (cause) {
    await rm(temporary, { recursive: true, force: true })
    return err(sourceError('SourceError', repository.url, 1, 1, 'Could not refresh the remote Markdown source.', cause))
  }
}
