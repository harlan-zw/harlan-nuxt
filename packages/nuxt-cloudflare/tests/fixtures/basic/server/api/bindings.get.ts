import { createCloudflareBindings } from '@harlan-zw/nuxt-cloudflare/bindings'

const bindings = createCloudflareBindings()

export default defineEventHandler((event) => {
  const statement = bindings.require('DB', event).prepare('SELECT 1')
  return { statement: Boolean(statement) }
})

if (false) {
  // @ts-expect-error Wrangler did not generate this binding.
  bindings.require('UNKNOWN')
}
