import { describe, expect, it } from 'vitest'
import { createParallelHookCaller } from '../src/runtime/server/parallel-hooks'

function serialHooks() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  return {
    hook(name: string, handler: (...args: any[]) => unknown) {
      const registered = handlers.get(name) ?? []
      registered.push(handler)
      handlers.set(name, registered)
    },
    callHook(name: string, ...args: any[]) {
      // HookableCore invokes synchronous handlers before waiting for a promise.
      const run = (index: number): unknown => {
        const handler = handlers.get(name)?.[index]
        if (!handler)
          return
        const pending = handler(...args)
        return pending instanceof Promise ? pending.then(() => run(index + 1)) : run(index + 1)
      }
      return run(0)
    },
  }
}

describe('parallel drain dispatch', () => {
  it('delivers to the other sink when the first sink rejects', async () => {
    const hooks = serialHooks()
    const dispatch = createParallelHookCaller(hooks, 'emit')
    const delivered: string[] = []
    hooks.hook('emit', async (record: string) => {
      delivered.push(`d1:${record}`)
      throw new Error('D1 unavailable')
    })
    hooks.hook('emit', async (record: string) => {
      delivered.push(`sentry:${record}`)
    })
    await expect(dispatch('request')).rejects.toThrow('D1 unavailable')
    expect(delivered).toEqual(['d1:request', 'sentry:request'])
  })

  it('waits for each sink and preserves ordinary serial hooks', async () => {
    const hooks = serialHooks()
    const dispatch = createParallelHookCaller(hooks, 'emit')
    const delivered: string[] = []
    hooks.hook('emit', async () => {
      await Promise.resolve()
      delivered.push('drain')
    })
    hooks.hook('close', async () => {
      await Promise.resolve()
      delivered.push('closed')
    })
    await dispatch()
    await hooks.callHook('close')
    expect(delivered).toEqual(['drain', 'closed'])
  })
})
