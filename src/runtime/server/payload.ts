export function buildJobPayload<const Name extends string, Payload extends object>(
  name: Name,
  payload: Payload,
): { _task: Name } & Payload {
  return { _task: name, ...payload }
}
