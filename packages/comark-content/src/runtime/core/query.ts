import type { IndexedContentDocument, PageCollectionItemBase } from '../types'

export type QueryOperator = '=' | '<>' | 'LIKE' | 'IS NULL' | 'IS NOT NULL'
export type QueryDirection = 'ASC' | 'DESC'

export type QueryOperation
  = | { _tag: 'Path', value: string }
    | { _tag: 'Where', field: string, operator: QueryOperator, value?: unknown }
    | { _tag: 'Order', field: string, direction: QueryDirection }
    | { _tag: 'Limit', value: number }
    | { _tag: 'Select', fields: string[] }

export interface QueryPlan { operations: QueryOperation[] }

export interface CollectionQuery<TItem extends Record<string, unknown>> {
  path: (path: string) => CollectionQuery<TItem>
  where: (field: string, operator: QueryOperator, value?: unknown) => CollectionQuery<TItem>
  order: (field: string, direction?: QueryDirection) => CollectionQuery<TItem>
  limit: (limit: number) => CollectionQuery<TItem>
  select: (...fields: string[]) => CollectionQuery<TItem>
  all: () => Promise<TItem[]>
  first: () => Promise<TItem | null>
}

const fieldValue = (item: Record<string, unknown>, field: string) => field.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, item)

const likePattern = (value: unknown) => new RegExp(`^${String(value).replaceAll(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('%', '.*').replaceAll('_', '.')}$`, 'i')

function matches(item: Record<string, unknown>, operation: Extract<QueryOperation, { _tag: 'Where' }>) {
  const value = fieldValue(item, operation.field)
  if (operation.operator === '=')
    return value === operation.value
  if (operation.operator === '<>')
    return value !== operation.value
  if (operation.operator === 'IS NULL')
    return value === null || value === undefined
  if (operation.operator === 'IS NOT NULL')
    return value !== null && value !== undefined
  return likePattern(operation.value).test(String(value ?? ''))
}

function compare(left: unknown, right: unknown) {
  if (left === right)
    return 0
  if (left === null || left === undefined)
    return 1
  if (right === null || right === undefined)
    return -1
  return typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right))
}

export function executeQueryPlan<TItem extends Record<string, unknown>>(items: TItem[], plan: QueryPlan): TItem[] {
  let result = [...items]
  const filters = plan.operations.filter((operation): operation is Extract<QueryOperation, { _tag: 'Where' | 'Path' }> => operation._tag === 'Where' || operation._tag === 'Path')
  for (const filter of filters) {
    result = filter._tag === 'Path'
      ? result.filter(item => String(item.path).replace(/\/$/, '') === filter.value.replace(/\/$/, ''))
      : result.filter(item => matches(item, filter))
  }
  const orders = plan.operations.filter((operation): operation is Extract<QueryOperation, { _tag: 'Order' }> => operation._tag === 'Order')
  const effectiveOrders = orders.length ? orders : [{ _tag: 'Order' as const, field: 'stem', direction: 'ASC' as const }]
  result.sort((left, right) => {
    for (const order of effectiveOrders) {
      const compared = compare(fieldValue(left, order.field), fieldValue(right, order.field))
      if (compared)
        return order.direction === 'DESC' ? -compared : compared
    }
    return 0
  })
  const limit = plan.operations.find((operation): operation is Extract<QueryOperation, { _tag: 'Limit' }> => operation._tag === 'Limit')
  if (limit)
    result = result.slice(0, limit.value)
  const select = plan.operations.findLast((operation): operation is Extract<QueryOperation, { _tag: 'Select' }> => operation._tag === 'Select')
  if (select) {
    result = result.map(item => Object.fromEntries(select.fields.map(field => [field, fieldValue(item, field)])) as TItem)
  }
  return result
}

export function createQueryBuilder<TItem extends Record<string, unknown>>(execute: (plan: QueryPlan) => Promise<TItem[]>): CollectionQuery<TItem> {
  const operations: QueryOperation[] = []
  const builder: CollectionQuery<TItem> = {
    path(value) {
      operations.push({ _tag: 'Path', value })
      return builder
    },
    where(field, operator, value) {
      operations.push({ _tag: 'Where', field, operator, value })
      return builder
    },
    order(field, direction = 'ASC') {
      operations.push({ _tag: 'Order', field, direction })
      return builder
    },
    limit(value) {
      operations.push({ _tag: 'Limit', value })
      return builder
    },
    select(...fields) {
      operations.push({ _tag: 'Select', fields })
      return builder
    },
    all: () => execute({ operations: [...operations] }),
    first: async () => (await execute({ operations: [...operations, { _tag: 'Limit', value: 1 }] }))[0] ?? null,
  }
  return builder
}

export const createCollectionQuery = <TItem extends Record<string, unknown>>(items: TItem[]) => createQueryBuilder<TItem>(async plan => executeQueryPlan(items, plan))

function usesBodyForPlanning(operation: QueryOperation) {
  return (operation._tag === 'Where' || operation._tag === 'Order')
    && (operation.field === 'body' || operation.field.startsWith('body.'))
}

export async function executeIndexedQueryPlan<TItem extends PageCollectionItemBase>(index: IndexedContentDocument<TItem>[], plan: QueryPlan, loadBody: (bodyAsset: string) => Promise<TItem['body']>): Promise<TItem[]> {
  if (plan.operations.some(usesBodyForPlanning))
    throw new TypeError('<request>:1:1 Markdown body fields cannot filter or order a collection query.')
  const select = plan.operations.findLast((operation): operation is Extract<QueryOperation, { _tag: 'Select' }> => operation._tag === 'Select')
  const metadataPlan = { operations: plan.operations.filter(operation => operation._tag !== 'Select') }
  const metadata = executeQueryPlan(index.map(item => item.metadata), metadataPlan)
  if (select && !select.fields.some(field => field === 'body' || field.startsWith('body.'))) {
    return metadata.map(item => Object.fromEntries(select.fields.map(field => [field, fieldValue(item, field)])) as TItem)
  }
  const bodyAssets = new Map(index.map(item => [item.metadata.id, item.bodyAsset]))
  const hydrated: TItem[] = []
  for (const item of metadata) {
    const bodyAsset = bodyAssets.get(item.id)
    if (!bodyAsset)
      throw new TypeError(`${item._source}:1:1 Missing generated Markdown body reference.`)
    hydrated.push({ ...item, body: await loadBody(bodyAsset) } as TItem)
  }
  return select
    ? hydrated.map(item => Object.fromEntries(select.fields.map(field => [field, fieldValue(item, field)])) as TItem)
    : hydrated
}

export function createIndexedCollectionQuery<TItem extends PageCollectionItemBase>(index: IndexedContentDocument<TItem>[], loadBody: (bodyAsset: string) => Promise<TItem['body']>) {
  return createQueryBuilder<TItem>(plan => executeIndexedQueryPlan(index, plan, loadBody))
}
