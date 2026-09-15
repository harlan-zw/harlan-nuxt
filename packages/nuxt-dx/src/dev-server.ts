import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const SERVER_FILE = 'node_modules/.cache/nuxt-dx/dev-server.json'

interface DevServer {
  pid: number
  url: string
}

export function resolveInspectionTarget(target: string, serverUrl?: string): string {
  if (target.startsWith('//') || target.includes('\\'))
    throw new Error('Provide a route path or a full HTTP or HTTPS URL.')
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
    const url = new URL(target)
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Provide an HTTP or HTTPS URL.')
    return url.href
  }
  if (!serverUrl)
    throw new Error('Start Nuxt dev in this project, or pass a full URL to inspect.')
  return new URL(target.replace(/^\//, ''), serverUrl).href
}

export function parseDevServer(value: unknown): DevServer {
  if (!value || typeof value !== 'object' || !('pid' in value) || !('url' in value)
    || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.url !== 'string' || !/^https?:\/\//.test(value.url)) {
    throw new Error('Invalid Nuxt DX server metadata. Restart Nuxt dev.')
  }
  return { pid: value.pid, url: resolveInspectionTarget(value.url) }
}

export async function discoverDevServer(cwd: string): Promise<string | undefined> {
  const source = await readFile(resolve(cwd, SERVER_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (source === undefined)
    return
  const server = parseDevServer(JSON.parse(source))
  const alive = (() => {
    try {
      process.kill(server.pid, 0)
      return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        return false
      if ((error as NodeJS.ErrnoException).code === 'EPERM')
        return true
      throw error
    }
  })()
  return alive ? server.url : undefined
}

/** Return cleanup for this listener without deleting another server's record. */
export async function recordDevServer(root: string, address: string, baseURL: string): Promise<() => Promise<void>> {
  const url = new URL(address)
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]')
    url.hostname = 'localhost'
  const file = resolve(root, SERVER_FILE)
  const source = JSON.stringify({ token: randomUUID(), pid: process.pid, url: new URL(baseURL, url).href })
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}`
  await writeFile(temporary, source)
  await rename(temporary, file)
  return async () => {
    const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return undefined
      throw error
    })
    if (current === source)
      await rm(file, { force: true })
  }
}
