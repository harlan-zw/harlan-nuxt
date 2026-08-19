export default defineEventHandler((event) => {
  setResponseStatus(event, 201)
  return { created: true }
})
