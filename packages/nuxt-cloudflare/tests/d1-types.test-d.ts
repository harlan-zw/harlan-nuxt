/// <reference types="@cloudflare/workers-types" />

import {
  getRecoveringRequestD1Session,
  withD1ResetRecovery,
} from '../src/d1'

export function recoverCloudflareD1Session(
  requestContext: Record<PropertyKey, unknown>,
  database: D1Database,
): D1DatabaseSession {
  const direct = withD1ResetRecovery(database)
  const request = getRecoveringRequestD1Session(requestContext, 'DB', database)
  return request.getBookmark() === null ? direct : request
}
