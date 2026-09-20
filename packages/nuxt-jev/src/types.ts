import type { JevSeatMode } from './runtime/core/modes'

export type { JevSeatMode }

export interface ModuleOptions {
  apiToken?: string
  accountId?: string
  gatewayId?: string
  model?: string
  cacheTtl?: number
  seatModes?: string
  defaultMode?: JevSeatMode
}
