import type {
  InputParser,
  ListenerDefinition,
  LocalEventDefinition,
  TransferCodec,
  TransferEventDefinition,
} from './types'

type ParserOutput<Parser> = Parser extends InputParser<infer Output> ? Output : never

export function defineEvent<const Name extends string, const Parser extends InputParser<any>>(
  definition: LocalEventDefinition<Name, ParserOutput<Parser>> & { input: Parser },
): LocalEventDefinition<Name, ParserOutput<Parser>>
export function defineEvent<const Name extends string, const Codec extends TransferCodec<any>>(
  definition: TransferEventDefinition<Name, ParserOutput<Codec>> & { codec: Codec },
): TransferEventDefinition<Name, ParserOutput<Codec>>
export function defineEvent(definition: LocalEventDefinition<string, unknown> | TransferEventDefinition<string, unknown>) {
  return definition
}

export function defineListener<
  const Name extends string,
  const Event extends string,
  const Parser extends InputParser<any>,
  Services = unknown,
>(definition: ListenerDefinition<Name, Event, ParserOutput<Parser>, Services> & { input: Parser }): ListenerDefinition<Name, Event, ParserOutput<Parser>, Services> & { input: Parser }
export function defineListener<
  const Name extends string,
  const Event extends string,
  Payload,
  Services = unknown,
>(definition: ListenerDefinition<Name, Event, Payload, Services> & { input?: undefined }): ListenerDefinition<Name, Event, Payload, Services>
export function defineListener(definition: ListenerDefinition<string, string, unknown, unknown>) {
  return definition
}
