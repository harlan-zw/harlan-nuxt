export default defineEventHandler(async () => {
  const wideEvent = createWideEvent({ 'user.id': 'standalone_1' })
  wideEvent.setLevel('warn')
  return await wideEvent.emit()
})
