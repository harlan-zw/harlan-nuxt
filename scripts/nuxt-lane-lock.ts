import { createHash } from 'node:crypto'

interface ArchiveSnapshot {
  resolution: { integrity: string, tarball?: string }
  version: string
}

export function refreshLocalArchive(snapshot: ArchiveSnapshot, archive: Uint8Array, version: string): ArchiveSnapshot {
  return {
    ...snapshot,
    version,
    resolution: {
      ...snapshot.resolution,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    },
  }
}
