import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const writeFixture = async (root: string, path: string, source: string) => {
  const target = join(root, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, source)
  return target
}
