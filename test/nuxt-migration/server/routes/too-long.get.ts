import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(() => new Response('<main>Cached document</main>', {
  headers: { 'content-type': 'text/html' },
}))
