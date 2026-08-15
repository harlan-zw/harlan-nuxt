import type { ContentError, Result } from '../runtime/types'

export const ok = <T>(value: T): Result<T> => ({ _tag: 'Ok', value })
export const err = <T = never>(error: ContentError): Result<T> => ({ _tag: 'Err', error })

export const sourceError = (
  tag: ContentError['_tag'],
  source: string,
  line: number,
  column: number,
  detail: string,
  cause?: unknown,
): ContentError => ({
  _tag: tag,
  source,
  line,
  column,
  message: `${source}:${line}:${column} ${detail}`,
  cause,
})
