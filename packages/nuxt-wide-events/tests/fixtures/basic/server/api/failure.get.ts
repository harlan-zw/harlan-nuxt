export default defineEventHandler(() => {
  throw createError({ statusCode: 404, message: 'secret-error-message' })
})
