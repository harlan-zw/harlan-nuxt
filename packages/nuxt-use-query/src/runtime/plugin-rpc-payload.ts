import type { NuxtRpcErrorData } from './rpc/core'
import { definePayloadPlugin, definePayloadReducer, definePayloadReviver } from '#app'
import { createNuxtRpcError, isNuxtRpcError, toSerializableNuxtRpcError } from './rpc/core'

// A failing query parks its error in `payload._errors`, which Nuxt serializes
// with devalue. An `Error` is not a plain object, so without this pair the
// render fails with "Cannot stringify arbitrary non-POJOs". The reducer keeps
// the tag and the diagnosis fields; the reviver rebuilds the same `Error` on
// the client, so a hydrated failure discriminates exactly like a fresh one.
export default definePayloadPlugin(() => {
  definePayloadReducer('NuxtRpcError', (value: unknown) => isNuxtRpcError(value) && toSerializableNuxtRpcError(value))
  definePayloadReviver('NuxtRpcError', (data: NuxtRpcErrorData) => createNuxtRpcError(data))
})
