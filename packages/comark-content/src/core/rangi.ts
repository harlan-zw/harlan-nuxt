import type { MarkdownDocument, Node } from 'comark'
import type { ShjLanguageDefinition, ShjLanguages, ShjThemePair } from 'rangi'
import { githubDark, githubLight } from 'rangi/themes'

const dotenvValue: ShjLanguageDefinition = [
  [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, 'str'],
  [/\$\{?[A-Za-z_]\w*(?:(?::-?|\?)[^}]*)?\}?/g, 'var'],
  [/\b(?:true|false)\b/gi, 'bool'],
  [/\b-?\d+(?:\.\d+)?\b/g, 'num'],
]

const dotenv: ShjLanguageDefinition = [
  [/#.*$/gm, 'cmnt'],
  [/^\s*export\b/gm, 'kwd'],
  [/\b[A-Za-z_]\w*(?=\s*=)/g, 'var'],
  [/=/g, 'oper'],
  [/(?<==)[ \t]*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^#\r\n]+)/g, 'str', dotenvValue],
]

const robotsValue: ShjLanguageDefinition = [
  [/[*$]/g, 'oper'],
  [/\b\d+(?:\.\d+)?\b/g, 'num'],
]

const robots: ShjLanguageDefinition = [
  [/#.*$/gm, 'cmnt'],
  [/^[A-Za-z][\w-]*(?=\s*:)/gm, 'kwd'],
  [/:/g, 'oper'],
  [/(?<=:)[^#\r\n]+/g, 'str', robotsValue],
]

export const contentRangiLanguages: ShjLanguages = {
  dotenv,
  env: dotenv,
  robots,
  'robots-txt': robots,
  'robots.txt': robots,
}

const contentRangiLight = {
  ...githubLight,
  name: 'comark-github-light-aa',
  tokens: { ...githubLight.tokens, cmnt: '#57606a' },
}

export const contentRangiTheme = {
  light: contentRangiLight,
  dark: githubDark,
} satisfies ShjThemePair

const addThemeVariables = (node: Node, inRangi = false): void => {
  if (typeof node === 'string' || node[0] === null)
    return
  const [tag, attributes, ...children] = node
  const rangi = inRangi || tag === 'pre' && typeof attributes.class === 'string' && attributes.class.split(/\s+/).includes('rangi')
  if (rangi && tag === 'span' && typeof attributes.style === 'string' && !attributes.style.includes('--shiki-light:')) {
    const light = /(?:^|;)color:([^;]+)/.exec(attributes.style)?.[1]
    if (light)
      attributes.style = `--shiki-light:${light};--shiki-default:${light};${attributes.style}`
  }
  for (const child of children)
    addThemeVariables(child as Node, rangi)
}

export const normalizeRangiThemeVariables = (document: MarkdownDocument): MarkdownDocument => {
  for (const node of document.nodes)
    addThemeVariables(node)
  return document
}
