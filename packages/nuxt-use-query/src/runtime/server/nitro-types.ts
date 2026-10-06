export type NativeFetch = (request: Request) => Promise<Response>

export type RuntimeApp = RuntimeHooks & (
  | { _tag: 'Nitro2' }
  | { _tag: 'Nitro3', fetch: NativeFetch, setFetch: (fetch: NativeFetch) => void }
)

interface RuntimeHooks {
  hooks: {
    hook: (name: string, handler: (...args: any[]) => any) => void
    callHook: (name: string, ...args: any[]) => Promise<void>
  }
}
