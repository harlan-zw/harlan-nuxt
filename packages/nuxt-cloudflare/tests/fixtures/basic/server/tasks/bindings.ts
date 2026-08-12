import { createCloudflareBindings } from '@harlan-zw/nuxt-cloudflare/bindings'

const bindings = createCloudflareBindings()

export default defineTask({
  meta: {
    name: 'bindings',
    description: 'Checks generated Cloudflare binding types.',
  },
  async run(event) {
    const response = await bindings.require('JOBS', event).send({ source: 'fixture' })
    return { result: response }
  },
})
