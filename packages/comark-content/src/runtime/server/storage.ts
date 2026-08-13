import type { PageCollectionItemBase } from '../types'
import { useStorage } from '#imports'

const collectionName = /^[A-Za-z][A-Za-z0-9_]*$/

export const loadCollection = async (name: string): Promise<PageCollectionItemBase[]> => {
  if (!collectionName.test(name))
    throw new TypeError(`<request>:1:1 Invalid collection name "${name}".`)
  const value = await useStorage('assets:comark-content').getItem<PageCollectionItemBase[]>(`${name}.json`)
  if (!value)
    throw new TypeError(`<request>:1:1 Unknown collection "${name}".`)
  return value
}

export const loadCollectionNames = async (): Promise<string[]> => {
  const names = await useStorage('assets:comark-content').getItem<string[]>('collections.json')
  if (!names)
    throw new TypeError('<request>:1:1 Missing generated collection metadata.')
  return names
}
