// Typed route used by the inference probe test. The shape of this handler's
// return value is what `useNuxtQuery('/api/typed-probe')` (no explicit
// generic) must infer.
export default defineEventHandler(() => ({
  message: 'hello',
  count: 42,
}))
