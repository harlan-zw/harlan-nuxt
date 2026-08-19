import { describe, expect, it } from 'vitest'
import { chainHandler } from '../src/runtime/app/handler-chain'

type Warn = (message: string) => void

/** Stands in for `vueApp.config.warnHandler`: one slot, last writer wins. */
function warnSlot(initial?: Warn) {
  let handler = initial
  return {
    current: () => handler,
    slot: {
      read: () => handler,
      write: (next: Warn | undefined) => {
        handler = next
      },
    },
  }
}

describe('chainHandler', () => {
  it('calls the handler that already held the slot', () => {
    const seen: string[] = []
    const previous: Warn = message => seen.push(`previous:${message}`)
    const { slot, current } = warnSlot(previous)

    chainHandler<Warn>(slot, (next, message) => {
      seen.push(`chain:${message}`)
      next?.(message)
    })
    current()!('boom')

    expect(seen).toEqual(['chain:boom', 'previous:boom'])
  })

  it('reports nothing to delegate when the slot was empty', () => {
    const seen: (Warn | undefined)[] = []
    const { slot, current } = warnSlot()

    chainHandler<Warn>(slot, (next) => {
      seen.push(next)
    })
    current()!('boom')

    expect(seen).toEqual([undefined])
  })

  it('takes the slot back from a handler installed later, and keeps that handler', () => {
    const seen: string[] = []
    const { slot, current } = warnSlot(message => seen.push(`first:${message}`))
    const chain = chainHandler<Warn>(slot, (next, message) => {
      seen.push(`chain:${message}`)
      next?.(message)
    })

    // A plugin that runs after this one assigns the slot, so the chain stops being called.
    slot.write(message => seen.push(`later:${message}`))
    current()!('one')
    chain.reinstall()
    current()!('two')

    expect(seen).toEqual(['later:one', 'chain:two', 'later:two'])
  })

  it('reinstalls without adding itself to its own chain', () => {
    const seen: string[] = []
    const { slot, current } = warnSlot()
    const chain = chainHandler<Warn>(slot, (next, message) => {
      seen.push(`chain:${message}`)
      next?.(message)
    })

    chain.reinstall()
    chain.reinstall()
    current()!('boom')

    expect(seen).toEqual(['chain:boom'])
  })

  it('gives the slot back to the handler it delegates to', () => {
    const seen: string[] = []
    const previous: Warn = message => seen.push(`previous:${message}`)
    const { slot, current } = warnSlot(previous)
    const chain = chainHandler<Warn>(slot, (next, message) => {
      seen.push(`chain:${message}`)
      next?.(message)
    })

    chain.restore()

    expect(current()).toBe(previous)
  })

  it('leaves a handler installed later alone when it gives the slot back', () => {
    const { slot, current } = warnSlot()
    const chain = chainHandler<Warn>(slot, () => {})
    const later: Warn = () => {}

    slot.write(later)
    chain.restore()

    expect(current()).toBe(later)
  })

  it('stops delegating once the handler it delegates to is dropped', () => {
    const seen: string[] = []
    const previous: Warn = message => seen.push(`previous:${message}`)
    const { slot, current } = warnSlot(previous)
    const chain = chainHandler<Warn>(slot, (next, message) => {
      seen.push(`chain:${message}`)
      next?.(message)
    })

    expect(chain.next()).toBe(previous)
    chain.setNext(undefined)
    current()!('boom')

    expect(seen).toEqual(['chain:boom'])
  })
})
