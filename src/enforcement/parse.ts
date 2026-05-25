import { parseSync } from 'oxc-parser'

export function parseSourceAst(file: string, source: string): any {
  return parseSync(file, source, {
    lang: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.jsx') ? 'jsx' : 'ts',
    sourceType: 'module',
  })
}

export function extractScriptSource(source: string, file: string): string {
  if (!file.endsWith('.vue'))
    return source
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1] ?? '')
    .join('\n')
}
