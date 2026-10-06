export interface RuntimeApp {
  hooks: {
    hook: (name: string, handler: (...args: any[]) => any) => void
    callHookParallel: (name: string, ...args: any[]) => Promise<void>
    callHook: (name: string, ...args: any[]) => Promise<void>
  }
}
