export const DEFAULT_MESSAGE_DEDUP_CAPACITY = 1024

export interface MessageDedup {
  has: (id: string | undefined) => boolean
  mark: (id: string | undefined) => void
}

const objectDedupSets = new WeakMap<object, Set<string>>()

export function createMessageDedup(
  seen: Set<string>,
  capacity = DEFAULT_MESSAGE_DEDUP_CAPACITY,
): MessageDedup {
  return {
    has(id) {
      return !!id && seen.has(id)
    },
    mark(id) {
      if (!id)
        return
      seen.add(id)
      if (seen.size > capacity) {
        const first = seen.values().next().value
        if (first !== undefined)
          seen.delete(first)
      }
    },
  }
}

export function createObjectMessageDedup(
  owner: object,
  capacity = DEFAULT_MESSAGE_DEDUP_CAPACITY,
): MessageDedup {
  let seen = objectDedupSets.get(owner)
  if (!seen) {
    seen = new Set()
    objectDedupSets.set(owner, seen)
  }
  return createMessageDedup(seen, capacity)
}
