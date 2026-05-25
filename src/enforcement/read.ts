import type { ContractQuerySourceFile, ResolvedContractQueryEnforcementOptions } from './types'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { normalize } from 'pathe'

export async function readSourceFilesFromDisk(rootDir: string, options: ResolvedContractQueryEnforcementOptions): Promise<ContractQuerySourceFile[]> {
  const files: ContractQuerySourceFile[] = []
  const ignored = new Set(options.ignore)
  const seen = new Set<string>()

  async function walk(dir: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      if (ignored.has(entry.name))
        continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!/\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name))
        continue
      const rel = normalize(relative(rootDir, path))
      if (seen.has(rel))
        continue
      seen.add(rel)
      files.push({
        file: rel,
        source: await readFile(path, 'utf8'),
      })
    }
  }

  for (const dir of await expandScanDirs(rootDir, options.scanDirs))
    await walk(dir)

  return files
}

/**
 * Expand `scanDirs` entries into absolute directory paths. Supports a single
 * `*` segment per pattern (e.g. `layers/*\/app`) by listing the parent dir and
 * appending the tail.
 */
async function expandScanDirs(rootDir: string, patterns: string[]): Promise<string[]> {
  const out: string[] = []
  for (const pattern of patterns) {
    const parts = pattern.split('/')
    const starIndex = parts.indexOf('*')
    if (starIndex === -1) {
      out.push(join(rootDir, ...parts))
      continue
    }
    const head = parts.slice(0, starIndex)
    const tail = parts.slice(starIndex + 1)
    const parent = join(rootDir, ...head)
    let entries
    try {
      entries = await readdir(parent, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue
      const candidate = join(parent, entry.name, ...tail)
      if (tail.length === 0) {
        out.push(candidate)
        continue
      }
      const exists = await stat(candidate).then(s => s.isDirectory(), () => false)
      if (exists)
        out.push(candidate)
    }
  }
  return out
}
