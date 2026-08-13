import { parseSync } from 'vite'

export function parseSourceAst(file: string, source: string): any {
  return parseSync(file, source, {
    lang: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.jsx') ? 'jsx' : 'ts',
    sourceType: 'module',
  })
}

export function extractScriptSource(source: string, file: string): string {
  if (!file.endsWith('.vue'))
    return source
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1] ?? '')
  const templateExpressions = extractVueTemplateExpressions(source)
  return [...scripts, ...templateExpressions].join('\n')
}

function extractVueTemplateExpressions(source: string): string[] {
  const templates = [...source.matchAll(/<template\b[^>]*>([\s\S]*?)<\/template>/gi)]
    .map(match => match[1] ?? '')
  const expressions: string[] = []
  for (const template of templates) {
    for (const match of template.matchAll(/\s(?:@[\w:-]+|v-on:[\w:-]+|:[\w:-]+|v-bind:[\w:-]+)=("([^"]*)"|'([^']*)')/gi)) {
      const expression = decodeHtmlEntities(match[2] ?? match[3] ?? '').trim()
      if (expression)
        expressions.push(expression)
    }
  }
  return expressions
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
