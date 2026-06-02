// Test stub for `nitropack/runtime`, which isn't resolvable outside a built
// nitro app. Only the symbols the runtime modules import at load time are
// needed; tests that exercise behaviour inject their own `useRuntimeConfig`.
export function defineTask<T = unknown>(def: T): T {
  return def
}

export function useRuntimeConfig(): unknown {
  return { cfJobs: { queues: {} } }
}

// Nitro plugins call `defineNitroPlugin(setup)` at module load; the stub just
// returns the setup fn so tests can invoke it with a fake NitroApp.
export function defineNitroPlugin<T>(setup: T): T {
  return setup
}
