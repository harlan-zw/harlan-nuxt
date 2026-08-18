import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareRemoteSource } from '../src/core/remote'
import { writeFixture } from './fixtures'

const exec = promisify(execFile)
const temporaryRoots: string[] = []

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'comark-content-remote-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('remote Markdown sources', () => {
  it('retries a public clone without invalid credentials', async () => {
    const root = await temporaryRoot()
    const calls: NodeJS.ProcessEnv[] = []
    const command = async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push(options.env)
      if (options.env.GIT_CONFIG_COUNT)
        throw new Error('remote: invalid credentials')
      await mkdir(args.at(-1)!, { recursive: true })
    }

    const result = await prepareRemoteSource({
      repository: { url: 'https://github.com/nuxt-modules/og-image', auth: { token: 'expired' } },
      include: 'docs/content/**/*.md',
    }, join(root, 'cache'), { command })

    expect(result._tag).toBe('Ok')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.GIT_CONFIG_COUNT).toBe('1')
    expect(calls[1]?.GIT_CONFIG_COUNT).toBeUndefined()
  })

  it('checks out a repository and never serves stale data after refresh failure', async () => {
    const root = await temporaryRoot()
    const repository = join(root, 'repository')
    const unavailable = join(root, 'repository-unavailable')
    await writeFixture(repository, 'docs/page.md', '# Remote')
    await exec('git', ['init', '--initial-branch=main'], { cwd: repository })
    await exec('git', ['add', '.'], { cwd: repository })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { cwd: repository })
    const source = { repository, include: 'docs/**/*.md' }

    const first = await prepareRemoteSource(source, join(root, 'cache'))
    expect(first._tag).toBe('Ok')
    await rename(repository, unavailable)
    const refresh = await prepareRemoteSource(source, join(root, 'cache'))

    expect(refresh).toMatchObject({
      _tag: 'Err',
      error: { _tag: 'SourceError', source: repository, line: 1, column: 1 },
    })
  })

  it('clones an immutable tag once and reuses the checkout', async () => {
    const root = await temporaryRoot()
    const clones: string[] = []
    const command = async (_command: string, args: string[]) => {
      clones.push(args.at(-1)!)
      await mkdir(args.at(-1)!, { recursive: true })
    }
    const source = { repository: { url: 'https://example.com/docs.git', tag: 'v1.2.3' }, include: '**/*.md' }

    const first = await prepareRemoteSource(source, join(root, 'cache'), { command })
    const second = await prepareRemoteSource(source, join(root, 'cache'), { command })

    expect(first).toEqual(second)
    expect(clones).toHaveLength(1)
  })

  it('reclones a mutable branch under the refresh policy', async () => {
    const root = await temporaryRoot()
    const clones: string[] = []
    const command = async (_command: string, args: string[]) => {
      clones.push(args.at(-1)!)
      await mkdir(args.at(-1)!, { recursive: true })
    }
    const source = { repository: { url: 'https://example.com/docs.git', branch: 'main' }, include: '**/*.md' }

    await prepareRemoteSource(source, join(root, 'cache'), { command })
    await prepareRemoteSource(source, join(root, 'cache'), { command })

    expect(clones).toHaveLength(2)
  })

  it('reuses any existing checkout under the reuse policy', async () => {
    const root = await temporaryRoot()
    const clones: string[] = []
    const command = async (_command: string, args: string[]) => {
      clones.push(args.at(-1)!)
      await mkdir(args.at(-1)!, { recursive: true })
    }
    const source = { repository: { url: 'https://example.com/docs.git', branch: 'main' }, include: '**/*.md' }
    const options = { command, policy: { _tag: 'ReuseExisting' } as const }

    const first = await prepareRemoteSource(source, join(root, 'cache'), { command })
    const second = await prepareRemoteSource(source, join(root, 'cache'), options)

    expect(first).toEqual(second)
    expect(clones).toHaveLength(1)
  })

  it('separates checkouts of the same repository by reference', async () => {
    const root = await temporaryRoot()
    const command = async (_command: string, args: string[]) => {
      await mkdir(args.at(-1)!, { recursive: true })
    }
    const url = 'https://example.com/docs.git'

    const stable = await prepareRemoteSource({ repository: { url, tag: 'v1' }, include: '**/*.md' }, join(root, 'cache'), { command })
    const next = await prepareRemoteSource({ repository: { url, tag: 'v2' }, include: '**/*.md' }, join(root, 'cache'), { command })

    expect(stable._tag).toBe('Ok')
    expect(next).not.toEqual(stable)
  })
})
