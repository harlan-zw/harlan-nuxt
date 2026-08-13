export type QueryOperator = '=' | '<>' | 'LIKE' | 'IS NULL'
export type QueryDirection = 'ASC' | 'DESC'

export type QueryOperation =
  | { _tag: 'Path', value: string }
  | { _tag: 'Where', field: string, operator: QueryOperator, value?: unknown }
  | { _tag: 'Order', field: string, direction: QueryDirection }
  | { _tag: 'Limit', value: number }
  | { _tag: 'Select', fields: string[] }

export type QueryPlan = { operations: QueryOperation[] }

export type CollectionQuery<TItem extends Record<string, unknown>> = {
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

const matches = (item: Record<string, unknown>, operation: Extract<QueryOperation, { _tag: 'Where' }>) => {
  const value = fieldValue(item, operation.field)
  if (operation.operator === '=')
    return value === operation.value
  if (operation.operator === '<>')
    return value !== operation.value
  if (operation.operator === 'IS NULL')
    return value === null || value === undefined
  return likePattern(operation.value).test(String(value ?? ''))
}

const compare = (left: unknown, right: unknown) => {
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

export const executeQueryPlan = <TItem extends Record<string, unknown>>(items: TItem[], plan: QueryPlan): TItem[] => {
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

export const createQueryBuilder = <TItem extends Record<string, unknown>>(
  execute: (plan: QueryPlan) => Promise<TItem[]>,
): CollectionQuery<TItem> => {
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
