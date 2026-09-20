/** How a seat treats its judgements: ask and record only, or also act. */
export type JevSeatMode = 'off' | 'shadow' | 'live'

export const DEFAULT_JEV_SEAT_MODE: JevSeatMode = 'shadow'
