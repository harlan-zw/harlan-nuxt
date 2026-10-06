import * as app from '#app'

interface Addon {
  setup: (options: any) => (result: any) => Record<string, unknown>
}

function withAddons(result: any, options: any, addons: Addon[]) {
  const extensions = Object.assign({}, ...addons.map(addon => addon.setup(options)(result)))
  Object.assign(result, extensions)
  if (result.then)
    void result.then((instance: any) => Object.assign(instance, extensions))
  return result
}

export const defineUseFetchAddon = (addon: Addon) => addon
export const defineUseAsyncDataAddon = (addon: Addon) => addon
export function createUseFetch({ addons }: { addons: Addon[] }) {
  return (request: any, options: any) =>
    withAddons(app.useFetch(request, options), options, addons)
}
export function createUseAsyncData({ addons }: { addons: Addon[] }) {
  return (...args: any[]) =>
    withAddons((app as any).useAsyncData(...args), args[2], addons)
}
