// Test stub for `nitropack/runtime`, which isn't resolvable outside a built
// nitro app. Only the symbols the runtime modules import at load time are
// needed; tests that exercise behaviour inject their own `useRuntimeConfig`.
export function defineTask<T = unknown>(def: T): T {
  return def
}

export function useRuntimeConfig(): unknown {
  return { cfJobs: { queues: {} } }
}
