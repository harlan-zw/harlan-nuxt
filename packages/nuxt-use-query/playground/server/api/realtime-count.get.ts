// Increments on every read so an invalidation-driven refetch is visible.
let count = 0

export default defineEventHandler(() => ({ count: ++count }))
