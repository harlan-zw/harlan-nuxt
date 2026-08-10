import type { ListenerDefinition } from '../src/runtime/server/types'
import { defineListener } from '../src/runtime/server/definitions'

type AssertTrue<Value extends true> = Value
interface EventPayload { value: string }
type WrongPayloadListener = ListenerDefinition<'wrong', 'test:event', { wrong: number }>
type CorrectPayloadListener = ListenerDefinition<'correct', 'test:event', EventPayload>

defineListener({
  name: 'without-input',
  event: 'test:event',
  handle: (_payload: unknown) => {},
})

defineListener({
  name: 'undefined-input',
  event: 'test:event',
  input: undefined,
  handle: (_payload: unknown) => {},
})

type CorrectPayloadMatchesEvent = AssertTrue<CorrectPayloadListener extends ListenerDefinition<string, 'test:event', EventPayload, any> ? true : false>
// @ts-expect-error generated registry assertions reject a listener payload unrelated to its event contract
type WrongPayloadMatchesEvent = AssertTrue<WrongPayloadListener extends ListenerDefinition<string, 'test:event', EventPayload, any> ? true : false>

export type { CorrectPayloadMatchesEvent, WrongPayloadMatchesEvent }
