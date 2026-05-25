import type { ContractRule } from '../types'
import { apiLiteralOutsideQueryRule } from './api-literal-outside-query'
import { missingContractImportRule } from './missing-contract-import'
import { mutationBodySchemaMissingRule } from './mutation-body-schema-missing'
import { operationResponseSchemaMissingRule } from './operation-response-schema-missing'
import { queryFileWithoutOperationRule } from './query-file-without-operation'
import { serverRouteMissingContractRule } from './server-route-missing-contract'

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
