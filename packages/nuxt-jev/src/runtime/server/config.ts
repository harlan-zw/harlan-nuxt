import type { JevSeatMode } from '../core/modes'
import { DEFAULT_JEV_MODEL } from '../core/client'
import { DEFAULT_JEV_SEAT_MODE } from '../core/modes'

export interface JevResolvedConfig {
  configured: boolean
  apiToken: string
  accountId: string
  gatewayId: string
  model: string
  cacheTtl: number
  seatModes: string
  defaultMode: JevSeatMode
}

const SEAT_MODES: readonly JevSeatMode[] = ['off', 'shadow', 'live']

export function resolveJevConfig(config: { apiToken?: string, accountId?: string, gatewayId?: string, model?: string, cacheTtl?: number, seatModes?: string, defaultMode?: string }): JevResolvedConfig {
  const apiToken = (config.apiToken ?? '').trim()
  const accountId = (config.accountId ?? '').trim()
  const cacheTtl = Number(config.cacheTtl ?? 0)
  const defaultMode = (SEAT_MODES as readonly string[]).includes(config.defaultMode ?? '')
    ? config.defaultMode as JevSeatMode
    : DEFAULT_JEV_SEAT_MODE
  return {
    configured: apiToken !== '' && accountId !== '',
    apiToken,
    accountId,
    gatewayId: (config.gatewayId ?? '').trim(),
    model: (config.model ?? '').trim() || DEFAULT_JEV_MODEL,
    cacheTtl: Number.isFinite(cacheTtl) && cacheTtl > 0 ? Math.floor(cacheTtl) : 0,
    seatModes: config.seatModes ?? '',
    defaultMode,
  }
}

// `seatModes` is a comma-separated list of `seat=mode` pairs. Malformed
// entries are dropped; the first pair naming the seat wins; every other seat
// falls back to `defaultMode`.
export function resolveJevSeatMode(seat: string, config: JevResolvedConfig): JevSeatMode {
  for (const pair of config.seatModes.split(',')) {
    const trimmed = pair.trim()
    if (trimmed === '')
      continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1)
      continue
    const [name, mode] = [trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1)]
    if (name === seat && (SEAT_MODES as readonly string[]).includes(mode))
      return mode as JevSeatMode
  }
  return config.defaultMode
}
