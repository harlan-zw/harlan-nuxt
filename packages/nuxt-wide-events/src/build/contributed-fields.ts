/**
 * Fields contributed by another Nuxt module rather than by the application.
 *
 * The allowlist is the whole point of this module: nothing reaches a Wide Event
 * unless it was declared first, and the build rejects any `addWideEventFields`
 * call naming a field that was not. That works cleanly for application code,
 * where the author writes both the config and the call. It does not work at all
 * for a module: a module that wants to record, say, which Cloudflare colo served
 * a request has no way to declare the field, so the call it makes in its own
 * server plugin fails the consuming application's build.
 *
 * Making the application hand-list a module's internal fields is the wrong fix.
 * It puts a list nobody can verify in a file nobody looks at, and the day the
 * module records one more field, every consuming application breaks — the
 * failure lands on the person least able to act on it.
 *
 * So a module declares its own through the `wide-events:fields` hook, and the
 * declaration lives next to the code that populates it. The application still
 * sees every field in the generated types and the allowlist is still
 * exhaustive; it is simply assembled from two sources rather than one.
 *
 * A HOOK rather than an exported function, deliberately. A contributing module
 * registers a listener during its own synchronous `setup` and needs no import
 * from this package, so it carries no dependency on it and works when this
 * module is absent — the hook simply never fires. It also removes the ordering
 * question: this module collects at `modules:done`, by which point every
 * module's `setup` has run, so contributing before or after is the same.
 */

export interface WideEventFieldRegistry {
  /**
   * Declare fields the calling module will populate at runtime.
   *
   * @param moduleName The contributing module, used to attribute a conflict.
   * @param fields Dotted lower-camel-case names, as in `wideEvents.fields`.
   */
  add: (moduleName: string, fields: readonly string[]) => void
}

export interface CollectedWideEventFields {
  fields: string[]
  /** Field name to the module that declared it. */
  contributors: Map<string, string>
}

export function createWideEventFieldRegistry(): CollectedWideEventFields & { registry: WideEventFieldRegistry } {
  const contributors = new Map<string, string>()
  return {
    contributors,
    get fields() {
      return [...contributors.keys()]
    },
    registry: {
      add(moduleName, fields) {
        for (const field of fields) {
          // First contributor wins, silently. Two modules declaring the same
          // well-known field (`cf.colo`, say) is a duplicate, not a conflict,
          // and failing an application's build over it would punish it for
          // installing two modules that happen to agree.
          if (!contributors.has(field))
            contributors.set(field, moduleName)
        }
      },
    },
  }
}
