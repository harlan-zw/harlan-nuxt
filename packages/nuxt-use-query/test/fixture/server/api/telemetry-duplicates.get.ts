export default defineEventHandler(async (event) => {
  const first = await event.$fetch('/api/echo', {
    query: { v: 'duplicate' },
  })
  const second = await event.$fetch('/api/echo', {
    query: { v: 'duplicate' },
  })
  return { first, second }
})
