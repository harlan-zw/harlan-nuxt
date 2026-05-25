import type { ContractQuerySourceFile, ResolvedContractQueryEnforcementOptions } from './types'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { normalize } from 'pathe'

export async function readSourceFilesFromDisk(rootDir: string, options: ResolvedContractQueryEnforcementOptions): Promise<ContractQuerySourceFile[]> {
  const files: ContractQuerySourceFile[] = []
  const ignored = new Set(options.ignore)

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name))
        continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (/\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name)) {
        files.push({
          file: normalize(relative(rootDir, path)),
          source: await readFile(path, 'utf8'),
        })
      }
    }
  }

  await walk(rootDir)
  return files
}
