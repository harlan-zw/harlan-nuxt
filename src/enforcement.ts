import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { normalize } from 'pathe'

export interface ContractQueryEnforcementOptions {
  /**
   * Fail the Nuxt build on architecture violations. Disabled by default so
   * existing consumers can adopt the contract pattern deliberately.
   */
  enabled?: boolean
  /** API prefixes that must be reached through query operations. */
  apiPrefixes?: string[]
  /** Files allowed to own API path literals and operation definitions. */
  queryDirs?: string[]
  /** Contract import locations expected from query files. */
  contractDirs?: string[]
  /** Server API route dirs that must also import shared contracts. */
  serverApiDirs?: string[]
  /** Require server/api route files to import from shared/contracts. */
  requireServerContracts?: boolean
  /** Extra path globs to skip. */
  ignore?: string[]
}

export interface ContractQueryViolation {
  code: 'api-literal-outside-query' | 'missing-contract-import' | 'mutation-body-schema-missing' | 'operation-response-schema-missing' | 'query-file-without-operation' | 'server-route-missing-contract'
  file: string
  message: string
}

export interface ResolvedContractQueryEnforcementOptions {
  apiPrefixes: string[]
  queryDirs: string[]
  contractDirs: string[]
  ignore: string[]
  requireServerContracts: boolean
  serverApiDirs: string[]
}

export interface ContractQuerySourceFile {
  file: string
  source: string
}

export interface ContractQueryEnforcerOptions {
  readSourceFiles?: (rootDir: string, options: ResolvedContractQueryEnforcementOptions) => Promise<ContractQuerySourceFile[]>
}

const DEFAULT_QUERY_DIRS = [
  'app/queries',
  'layers/*/app/queries',
]

const DEFAULT_CONTRACT_DIRS = [
  'shared/contracts',
  'layers/*/shared/contracts',
]

const DEFAULT_SERVER_API_DIRS = [
  'server/api',
  'layers/*/server/api',
]

const DEFAULT_IGNORE = [
  '.git',
  '.nuxt',
  '.output',
  'coverage',
  'dist',
  'node_modules',
]

export function resolveContractQueryEnforcementOptions(options: ContractQueryEnforcementOptions = {}): ResolvedContractQueryEnforcementOptions {
  return {
    apiPrefixes: options.apiPrefixes ?? ['/api'],
    queryDirs: options.queryDirs ?? DEFAULT_QUERY_DIRS,
    contractDirs: options.contractDirs ?? DEFAULT_CONTRACT_DIRS,
    ignore: options.ignore ?? DEFAULT_IGNORE,
    requireServerContracts: options.requireServerContracts ?? false,
    serverApiDirs: options.serverApiDirs ?? DEFAULT_SERVER_API_DIRS,
  }
}

export function createContractQueryEnforcer(options: ContractQueryEnforcerOptions = {}) {
  const readSourceFiles = options.readSourceFiles ?? readSourceFilesFromDisk

  return {
    async scan(rootDir: string, scanOptions: ContractQueryEnforcementOptions = {}): Promise<ContractQueryViolation[]> {
      const resolved = resolveContractQueryEnforcementOptions(scanOptions)
      const files = await readSourceFiles(rootDir, resolved)
      const violations: ContractQueryViolation[] = []

      for (const sourceFile of files) {
        const file = normalize(sourceFile.file)
        const source = extractScriptSource(sourceFile.source, file)
        const analysis = analyzeSource(file, source, resolved)
        const isQueryFile = matchesAnyDirectory(file, resolved.queryDirs)
        const isServerApiFile = matchesAnyDirectory(file, resolved.serverApiDirs)

        if (resolved.requireServerContracts && isServerApiFile && !analysis.hasContractImport) {
          violations.push({
            code: 'server-route-missing-contract',
            file,
            message: `Server API routes must import request/response schemas from shared/contracts: ${file}`,
          })
        }

        if (analysis.hasApiLiteral && !isQueryFile) {
          violations.push({
            code: 'api-literal-outside-query',
            file,
            message: `Move API path literals into an app/queries operation: ${file}`,
          })
          continue
        }

        if (!isQueryFile)
          continue

        if (analysis.hasApiLiteral && !analysis.hasOperation) {
          violations.push({
            code: 'query-file-without-operation',
            file,
            message: `Query files that own API paths must define Nuxt RPC operations: ${file}`,
          })
        }

        if (analysis.hasOperation && !analysis.hasContractImport) {
          violations.push({
            code: 'missing-contract-import',
            file,
            message: `Query operations must import Zod schemas from shared/contracts: ${file}`,
          })
        }

        if (analysis.hasOperationMissingResponse) {
          violations.push({
            code: 'operation-response-schema-missing',
            file,
            message: `Nuxt RPC operations must declare response: schema: ${file}`,
          })
        }

        if (analysis.hasBodyMutationMissingBody) {
          violations.push({
            code: 'mutation-body-schema-missing',
            file,
            message: `POST/PATCH/PUT mutations must declare body: schema or body: null: ${file}`,
          })
        }
      }

      return violations
    },

    format: formatContractQueryViolations,
  }
}

export async function scanContractQueryViolations(rootDir: string, options: ContractQueryEnforcementOptions = {}): Promise<ContractQueryViolation[]> {
  return createContractQueryEnforcer().scan(rootDir, options)
}

interface SourceAnalysis {
  hasApiLiteral: boolean
  hasBodyMutationMissingBody: boolean
  hasContractImport: boolean
  hasOperation: boolean
  hasOperationMissingResponse: boolean
}

function analyzeSource(file: string, source: string, options: ResolvedContractQueryEnforcementOptions): SourceAnalysis {
  const analysis: SourceAnalysis = {
    hasApiLiteral: false,
    hasBodyMutationMissingBody: false,
    hasContractImport: false,
    hasOperation: false,
    hasOperationMissingResponse: false,
  }

  if (!source.trim())
    return analysis

  const parsed = parseSync(file, source, {
    lang: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.jsx') ? 'jsx' : 'ts',
    sourceType: 'module',
  })

  walk(parsed.program, {
    enter(node: any) {
      if (node.type === 'ImportDeclaration') {
        const sourceValue = node.source?.value
        if (typeof sourceValue === 'string' && isContractImport(sourceValue, options.contractDirs))
          analysis.hasContractImport = true
        return
      }

      if (isApiLiteralNode(node, options.apiPrefixes)) {
        analysis.hasApiLiteral = true
        return
      }

      if (node.type !== 'CallExpression')
        return

      const calleeName = getCalleeName(node.callee)
      if (!calleeName || !isRpcOperationCallee(calleeName))
        return

      analysis.hasOperation = true
      if (calleeName === 'defineNuxtQueryGroup')
        return

      const operation = node.arguments?.[0]
      if (operation?.type !== 'ObjectExpression')
        return

      const props = getObjectProperties(operation)
      if (!props.has('response'))
        analysis.hasOperationMissingResponse = true

      if (calleeName === 'defineNuxtRpcMutation') {
        const method = getLiteralString(props.get('method')?.value)
        if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && !props.has('body'))
          analysis.hasBodyMutationMissingBody = true
      }
    },
  })

  return analysis
}

export function formatContractQueryViolations(violations: ContractQueryViolation[]): string {
  const lines = violations.map(violation => `- [${violation.code}] ${violation.message}`)
  return [
    'nuxt-use-query contract enforcement failed:',
    ...lines,
  ].join('\n')
}

async function readSourceFilesFromDisk(rootDir: string, options: ResolvedContractQueryEnforcementOptions): Promise<ContractQuerySourceFile[]> {
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

function extractScriptSource(source: string, file: string): string {
  if (!file.endsWith('.vue'))
    return source
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1] ?? '')
    .join('\n')
}

function isContractImport(importSource: string, contractDirs: string[]): boolean {
  return (
    /shared\/contracts(?:\/|$)/.test(importSource)
    || contractDirs.some(dir => directoryPatternToRegExp(dir).test(importSource))
  )
}

function matchesAnyDirectory(file: string, patterns: string[]): boolean {
  return patterns.some(pattern => directoryPatternToRegExp(pattern).test(file))
}

function directoryPatternToRegExp(pattern: string): RegExp {
  const normalized = normalize(pattern).replace(/^\/+|\/+$/g, '')
  const escaped = normalized
    .split('/')
    .map(part => part === '*' ? '[^/]+' : escapeRegExp(part))
    .join('/')
  return new RegExp(`(^|/)${escaped}(/|$)`)
}

function isApiLiteralNode(node: any, apiPrefixes: string[]): boolean {
  if (node.type === 'Literal' && typeof node.value === 'string')
    return apiPrefixes.some(prefix => node.value === prefix || node.value.startsWith(`${prefix}/`) || node.value.startsWith(`${prefix}?`))

  if (node.type === 'TemplateElement') {
    const value = node.value?.cooked ?? node.value?.raw
    return typeof value === 'string' && apiPrefixes.some(prefix => value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`))
  }

  return false
}

function isRpcOperationCallee(name: string): boolean {
  return name === 'defineNuxtRpcQuery'
    || name === 'defineNuxtRpcMutation'
    || name === 'defineNuxtQueryGroup'
}

function getCalleeName(callee: any): string | null {
  if (callee?.type === 'Identifier')
    return callee.name
  if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier')
    return callee.property.name
  return null
}

function getObjectProperties(node: any): Map<string, any> {
  const props = new Map<string, any>()
  for (const prop of node.properties ?? []) {
    if (prop.type !== 'Property')
      continue
    const name = getPropertyName(prop.key)
    if (name)
      props.set(name, prop)
  }
  return props
}

function getPropertyName(node: any): string | null {
  if (node?.type === 'Identifier')
    return node.name
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  return null
}

function getLiteralString(node: any): string | null {
  return node?.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
