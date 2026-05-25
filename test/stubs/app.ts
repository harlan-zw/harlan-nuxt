// Stub for `#app` used by vitest's default (happy-dom) environment. Real
// implementations are injected via `vi.mock('#app', ...)` per test. The
// `nuxt` env (used by `*.nuxt.test.ts` files) overrides this alias via its
// own vite plugin so the real Nuxt runtime is loaded there.
export const useFetch: any = undefined
export const useNuxtApp: any = undefined
export const refreshNuxtData: any = undefined
export const clearNuxtData: any = undefined
