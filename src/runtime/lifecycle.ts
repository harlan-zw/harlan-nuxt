export type Outcome<TData, TError = unknown>
  = | { _tag: 'ok', data: TData }
    | { _tag: 'err', error: TError }

export async function toOutcome<TData, TError = unknown>(
  perform: () => Promise<TData>,
  mapError: (error: unknown) => TError,
): Promise<Outcome<TData, TError>> {
  try {
    return { _tag: 'ok', data: await perform() }
  }
  catch (error) {
    return { _tag: 'err', error: mapError(error) }
  }
}

export async function runIsolatedHooks(
  hooks: Array<() => void | Promise<void>>,
  errorMessage: string,
): Promise<unknown> {
  let firstFailure: unknown
  for (const hook of hooks) {
    const failure = await runIsolatedHook(hook, errorMessage)
    if (firstFailure === undefined && failure !== undefined)
      firstFailure = failure
  }
  return firstFailure
}

async function runIsolatedHook(invoke: () => void | Promise<void>, errorMessage: string): Promise<unknown> {
  try {
    await invoke()
    return undefined
  }
  catch (error) {
    console.error(errorMessage, error)
    return error
  }
}
