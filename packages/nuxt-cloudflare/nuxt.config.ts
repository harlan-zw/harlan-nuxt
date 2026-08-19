export default defineNuxtConfig({
  // @ts-expect-error Module Builder loads this config before it generates module option types.
  nuxtCloudflare: {
    bindingTypes: false,
  },
  typescript: {
    tsConfig: {
      exclude: ['../tests/fixtures'],
    },
  },
})
