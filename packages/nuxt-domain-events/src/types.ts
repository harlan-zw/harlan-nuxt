export interface ModuleOptions {
  /** Relative source directories, scanned in the app and every Nuxt layer by default. */
  eventsDir?: string | string[]
  listenersDir?: string | string[]
  eventsPattern?: string
  listenersPattern?: string
  eventsIgnore?: string[]
  listenersIgnore?: string[]
  scanLayers?: boolean
  /** Logical queue names accepted by queued listener metadata. */
  queues?: string[]
  /** Allow a layer to contribute listeners whose event contract is supplied by final app composition. */
  allowExternalEvents?: boolean
  /** Allow an isolated layer to defer logical queue validation to final app composition. */
  allowExternalQueues?: boolean
  /** Critical contract names which must remain enabled and discovered. */
  requiredEvents?: string[]
  /** Critical listener names which must remain enabled and discovered. */
  requiredListeners?: string[]
  /** Public extension contracts intentionally permitted to have no listeners in the assembled app. */
  allowEmptyEvents?: string[]
  /** Server module exporting observeEventListener and optionally observeEventListenerFallback. */
  observer?: string
  /**
   * Server module exporting `createQueuedEventListenerContext(jobContext)`.
   * Required to contribute the generic cf-jobs delivery definition.
   */
  queuedDeliveryContext?: string
}
