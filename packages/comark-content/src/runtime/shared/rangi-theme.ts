import type { ShjLanguageDefinition, ShjLanguages, ShjThemePair } from 'rangi'
import { githubDark, githubLight } from 'rangi/themes'

/**
 * The theme and the extra languages, kept under `runtime` so the build emits a file a
 * site can import. `core/rangi.ts` is bundled into the module entry, which Nuxt import
 * protection puts out of reach of app code.
 */
const dotenvValue: ShjLanguageDefinition = [
  [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, 'str'],
  [/\$\{?[A-Z_]\w*(?:(?::|\?)[^}]*)?\}?/gi, 'var'],
  [/\b(?:true|false)\b/gi, 'bool'],
  [/\b-?\d+(?:\.\d+)?\b/g, 'num'],
]

const dotenv: ShjLanguageDefinition = [
  [/#.*$/gm, 'cmnt'],
  [/^\s*export\b/gm, 'kwd'],
  [/\b[A-Z_]\w*(?=\s*=)/gi, 'var'],
  [/=/g, 'oper'],
  [/(?<==)[ \t]*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^#\r\n]+)/g, 'str', dotenvValue],
]

const robotsValue: ShjLanguageDefinition = [
  [/[*$]/g, 'oper'],
  [/\b\d+(?:\.\d+)?\b/g, 'num'],
]

const robots: ShjLanguageDefinition = [
  [/#.*$/gm, 'cmnt'],
  [/^[A-Z][\w-]*(?=\s*:)/gim, 'kwd'],
  [/:/g, 'oper'],
  [/(?<=:)[^#\r\n]+/g, 'str', robotsValue],
]

export const contentRangiLanguages: ShjLanguages = {
  dotenv,
  'env': dotenv,
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
