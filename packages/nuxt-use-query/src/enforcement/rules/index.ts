import type { ContractRule } from '../types'
import { apiLiteralOutsideQueryRule } from './api-literal-outside-query.ts'
import { missingContractImportRule } from './missing-contract-import.ts'
import { mutationBodySchemaMissingRule } from './mutation-body-schema-missing.ts'
import { operationResponseSchemaMissingRule } from './operation-response-schema-missing.ts'
import { queryFileWithoutOperationRule } from './query-file-without-operation.ts'
import { serverRouteMissingContractRule } from './server-route-missing-contract.ts'

export {
  apiLiteralOutsideQueryRule,
  missingContractImportRule,
  mutationBodySchemaMissingRule,
  operationResponseSchemaMissingRule,
  queryFileWithoutOperationRule,
  serverRouteMissingContractRule,
}

/**
 * Registry order mirrors the violation order callers observe in test
 * assertions: server-route check first, then api-literal short-circuit, then
 * the query-file rule set.
 */
export const contractRules: readonly ContractRule[] = [
  serverRouteMissingContractRule,
  apiLiteralOutsideQueryRule,
  queryFileWithoutOperationRule,
  missingContractImportRule,
  operationResponseSchemaMissingRule,
  mutationBodySchemaMissingRule,
]
