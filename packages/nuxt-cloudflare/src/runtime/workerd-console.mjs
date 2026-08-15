// Mirrors nitro's `presets/_unenv/workerd/console.mjs`, with one difference:
// the base console is the existing global, not `#workerd/node:console`.
//
// Nitro maps the hybrid `console` module to a shim that re-exports every method
// from `#workerd/node:console`, which its rollup plugin rewrites to an external
// `node:console`. workerd treats that import as a signal to replace the global
// console with its Node-compatible Console, and that Console declares
// `createTask` but throws ERR_METHOD_NOT_IMPLEMENTED when it is called.
// `hookable` reads `typeof console.createTask !== 'undefined'` once at module
// scope and then calls it for every hook, so every route that runs Nitro hooks
// returns a 500. The import only lands in the bundle when some dependency
// touches `console` as a module, so it hits some Workers and not others.
//
// workerd's own global console has a working `createTask`, so sourcing from it
// keeps the same export surface, keeps logging on the same object Cloudflare
// captures, and never triggers the swap.
import {
  _ignoreErrors,
  _stderr,
  _stderrErrorHandler,
  _stdout,
  _stdoutErrorHandler,
  _times,
  Console,
} from 'unenv/node/console'

export {
  _ignoreErrors,
  _stderr,
  _stderrErrorHandler,
  _stdout,
  _stdoutErrorHandler,
  _times,
  Console,
} from 'unenv/node/console'

const workerdConsole = globalThis.console

export const {
  assert,
  clear,
  context,
  count,
  countReset,
  createTask,
  debug,
  dir,
  dirxml,
  error,
  group,
  groupCollapsed,
  groupEnd,
  info,
  log,
  profile,
  profileEnd,
  table,
  time,
  timeEnd,
  timeLog,
  timeStamp,
  trace,
  warn,
} = workerdConsole

const consolePolyfill = {
  Console,
  _ignoreErrors,
  _stderr,
  _stderrErrorHandler,
  _stdout,
  _stdoutErrorHandler,
  _times,
}

const consoleModule = /* @__PURE__ */ new Proxy(workerdConsole, {
  get(target, prop) {
    if (Reflect.has(target, prop))
      return Reflect.get(target, prop)
    return Reflect.get(consolePolyfill, prop)
  },
})

export default consoleModule
