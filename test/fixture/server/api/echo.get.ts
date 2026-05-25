// A trivial endpoint the runtime tests hit through `useFetch` /
// `useNuxtQuery`. Returns the `q` query param along with a monotonically
// increasing call counter so a test can assert that a refresh actually
// re-ran the server handler.

let callCount = 0

export default defineEventHandler((event) => {
  const q = getQuery(event)
  callCount += 1
  return { value: String(q.v ?? ''), call: callCount }
})
