import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

const output = process.env.NUXT_DX_TERMINAL_EVENTS

function record(event) {
  if (!output)
    return
  mkdirSync(dirname(output), { recursive: true })
  appendFileSync(output, `${JSON.stringify(event)}\n`)
}

globalThis[Symbol.for('nuxt:terminal-host')] = {
  version: 1,
  withTerminal: work => work(),
  notify(notification) {
    record({ type: 'notification', ...notification })
    return { dismiss() {}, dismissed: Promise.resolve() }
  },
  startTask(label) {
    record({ type: 'task:start', label })
    return {
      update(nextLabel) {
        record({ type: 'task:update', label: nextLabel })
      },
      stop(message, outcome) {
        record({ type: 'task:stop', message, outcome })
      },
    }
  },
}
