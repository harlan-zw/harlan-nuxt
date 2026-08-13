export default defineEventHandler(() => {
  const wideEvent = createWideEvent({ 'user.id': 'standalone_1' })
  wideEvent.setLevel('warn')
  return wideEvent.emit()
})
