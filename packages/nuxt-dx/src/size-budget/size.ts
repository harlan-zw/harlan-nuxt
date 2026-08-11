const UNITS = [
  { label: 'GB', scale: 1024 ** 3 },
  { label: 'MB', scale: 1024 ** 2 },
  { label: 'kB', scale: 1024 },
  { label: 'B', scale: 1 },
] as const

export function kilobytesToBytes(kilobytes: number): number {
  return Math.round(kilobytes * 1024)
}

export function formatBytes(bytes: number): string {
  const unit = UNITS.find(candidate => bytes >= candidate.scale) ?? UNITS[UNITS.length - 1]!
  return `${Number((bytes / unit.scale).toFixed(1))} ${unit.label}`
}

/** A change in size always carries its direction, so `0 B` never reads as a shrink. */
export function formatDelta(bytes: number): string {
  return `${bytes < 0 ? '-' : '+'}${formatBytes(Math.abs(bytes))}`
}
