import { createWideEvent } from '@harlan-zw/nuxt-wide-events/standalone'

export default defineEventHandler(async () => {
  const wideEvent = createWideEvent({ 'user.id': 'deep_1' })
  wideEvent.setLevel('warn')
  return await wideEvent.emit()
})
