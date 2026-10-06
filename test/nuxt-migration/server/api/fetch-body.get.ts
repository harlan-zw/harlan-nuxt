import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(async (event) => {
  const response = await fetch(new URL('/api/echo', event.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 17 }),
  })
  return response.json()
})
