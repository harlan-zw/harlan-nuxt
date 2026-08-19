import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeFixture(root: string, path: string, source: string) {
  const target = join(root, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, source)
  return target
}
