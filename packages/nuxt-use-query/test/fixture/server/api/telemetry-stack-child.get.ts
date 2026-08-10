export default defineEventHandler((event) => {
  return {
    stack: getHeader(event, 'x-nuxt-use-query-fetch-stack') ?? '',
    token: getHeader(event, 'x-nuxt-use-query-fetch-stack-token') ?? '',
  }
})
