/**
 * A Vue app config slot such as `warnHandler` holds exactly one function. Every plugin that
 * wants to see warnings assigns to it, and the last assignment wins, so every plugin that
 * assigned earlier goes silent without a word. A chain keeps the handler it displaced and
 * calls it, and can take the slot back from a handler installed after it.
 */

type AnyHandler = (...args: never[]) => void

export interface HandlerSlot<Fn extends AnyHandler> {
  read: () => Fn | undefined
  write: (handler: Fn | undefined) => void
}

export interface HandlerChain<Fn extends AnyHandler> {
  /** The handler this one delegates to, or nothing when it is last in the chain. */
  next: () => Fn | undefined
  /** Replaces the handler this one delegates to. */
  setNext: (handler: Fn | undefined) => void
  /** Takes the slot back from a handler installed later, and delegates to that handler. */
  reinstall: () => void
  /** Gives the slot back. Does nothing when a handler installed later owns it. */
  restore: () => void
}

export function chainHandler<Fn extends AnyHandler>(
  slot: HandlerSlot<Fn>,
  handle: (next: Fn | undefined, ...args: Parameters<Fn>) => void,
): HandlerChain<Fn> {
  let next = slot.read()
  const handler = ((...args: Parameters<Fn>) => {
    handle(next, ...args)
  }) as unknown as Fn
  slot.write(handler)
  return {
    next: () => next,
    setNext: (replacement) => {
      next = replacement
    },
    reinstall: () => {
      const current = slot.read()
      // Reinstalling while this chain still owns the slot would make it delegate to itself.
      if (current === handler)
        return
      next = current
      slot.write(handler)
    },
    restore: () => {
      if (slot.read() === handler)
        slot.write(next)
    },
  }
}
