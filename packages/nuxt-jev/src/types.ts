import type { JevSeatMode } from '@harlan-zw/jev'

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
