import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectSetupWarnings, resolveLayerFile, resolveQueueNames } from '../src/build/options'

describe('resolveQueueNames', () => {
  it('derives queues when the option is omitted', () => {
    expect(resolveQueueNames(undefined, ['jobs', 'mail'])).toEqual(['jobs', 'mail'])
  })

  it('derives queues when the option is an empty array', () => {
    expect(resolveQueueNames([], ['jobs', 'mail'])).toEqual(['jobs', 'mail'])
  })

  it('keeps an explicit queue list', () => {
    expect(resolveQueueNames(['only'], ['jobs', 'mail'])).toEqual(['only'])
  })
})

describe('collectSetupWarnings', () => {
  it('warns when no observer is configured', () => {
    expect(collectSetupWarnings({})).toEqual([
      'No domainEvents.observer is configured. Listener and dispatch failures reach stderr only. Set domainEvents.observer to report them.',
    ])
  })

  it('stays silent when an observer is configured', () => {
    expect(collectSetupWarnings({ observer: './server/observer' })).toEqual([])
  })
})

describe('resolveLayerFile', () => {
  it('resolves a relative path against the layer that ships the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domain-events-layer-'))
    const layer = join(root, 'layer')
    await mkdir(join(layer, 'server'), { recursive: true })
    await writeFile(join(layer, 'server/observer.ts'), 'export const observeEventListener = () => {}')

    expect(resolveLayerFile('./server/observer', [root, layer])).toEqual({
      _tag: 'ok',
      path: join(layer, 'server/observer.ts'),
    })
  })

  it('prefers the app root over a layer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domain-events-layer-'))
    const layer = join(root, 'layer')
    await mkdir(join(root, 'server'), { recursive: true })
    await mkdir(join(layer, 'server'), { recursive: true })
    await writeFile(join(root, 'server/observer.ts'), 'export const observeEventListener = () => {}')
    await writeFile(join(layer, 'server/observer.ts'), 'export const observeEventListener = () => {}')

    expect(resolveLayerFile('./server/observer', [root, layer])).toEqual({
      _tag: 'ok',
      path: join(root, 'server/observer.ts'),
    })
  })

  it('returns an absolute path unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domain-events-layer-'))
    await mkdir(join(root, 'server'), { recursive: true })
    const absolute = join(root, 'server/observer.ts')
    await writeFile(absolute, 'export const observeEventListener = () => {}')

    expect(resolveLayerFile(absolute, [root])).toEqual({ _tag: 'ok', path: absolute })
  })

  it('reports every searched root when the file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domain-events-layer-'))
    const result = resolveLayerFile('./server/observer', [root])
    expect(result._tag).toBe('err')
    if (result._tag === 'err')
      expect(result.searched).toEqual([join(root, 'server/observer')])
  })
})
