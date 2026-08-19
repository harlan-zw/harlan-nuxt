export const useRuntimeConfig = () => ({ public: { comarkContentRevision: 'test-build' } })

const assets = new Map<string, Uint8Array>()

/** Load the generated assets a test wants `assets:comark-content` to serve. */
export function setTestContentAssets(entries: Iterable<[string, Uint8Array]>) {
  assets.clear()
  for (const [path, data] of entries)
    assets.set(path, data)
}

export function useStorage(base: string) {
  if (base !== 'assets:comark-content')
    throw new Error(`Unexpected storage base "${base}".`)
  return { getItemRaw: async (path: string) => assets.get(path) ?? null }
}

export const defineEventHandler = <T>(handler: T) => handler

export const readBody = async (event: { _body?: unknown }) => event._body
