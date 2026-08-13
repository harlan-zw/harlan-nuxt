export default defineEventHandler((event) => {
  event.node.res.statusCode = 201
  return { created: true }
})
