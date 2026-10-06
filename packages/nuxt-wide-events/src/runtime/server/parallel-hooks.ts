interface Hooks {
  hook: (name: string, handler: (...args: any[]) => any) => unknown
  callHook: (name: string, ...args: any[]) => unknown
}

/** Preserve independent drains on Nitro 3's serial HookableCore. */
export function createParallelHookCaller(hooks: Hooks, name: string) {
  const register = hooks.hook.bind(hooks)
  const active: Promise<unknown>[][] = []
  hooks.hook = (hookName, handler) => register(hookName, hookName === name
    ? (...args) => {
        const pending = Promise.resolve().then(() => handler(...args))
        const dispatch = active.at(-1)
        if (!dispatch)
          return pending
        dispatch.push(pending)
      }
    : handler)

  return async (...args: any[]): Promise<void> => {
    const pending: Promise<unknown>[] = []
    active.push(pending)
    let invocation: unknown
    try {
      invocation = hooks.callHook(name, ...args)
    }
    finally {
      active.pop()
    }
    await invocation
    await Promise.all(pending)
  }
}
