import type { FetchTelemetryRuntimeOptions } from '../runtime/telemetry'
import { addServerPlugin } from '@nuxt/kit'
import { DEFAULT_FETCH_TELEMETRY_OPTIONS } from '../runtime/telemetry'

export type ModuleTelemetryOptions = boolean | Partial<FetchTelemetryRuntimeOptions>

export function setupFetchTelemetryModule(
  input: ModuleTelemetryOptions | undefined,
  runtimeConfig: Record<string, any>,
  serverPlugin: string,
): void {
  const telemetry = resolveModuleTelemetryOptions(input)
  setPublicRuntimeTelemetryConfig(runtimeConfig, telemetry)
  if (!telemetry.enabled)
    return

  setRuntimeTelemetryConfig(runtimeConfig, telemetry)
  addServerPlugin(serverPlugin)
}

export function resolveModuleTelemetryOptions(input: ModuleTelemetryOptions | undefined): FetchTelemetryRuntimeOptions {
  if (input === false || input == null) {
    return {
      ...DEFAULT_FETCH_TELEMETRY_OPTIONS,
      enabled: false,
    }
  }
  if (input === true)
    return { ...DEFAULT_FETCH_TELEMETRY_OPTIONS }
  return {
    ...DEFAULT_FETCH_TELEMETRY_OPTIONS,
    ...input,
    enabled: input.enabled ?? true,
  }
}

function setRuntimeTelemetryConfig(runtimeConfig: Record<string, any>, telemetry: FetchTelemetryRuntimeOptions): void {
  runtimeConfig.nuxtUseQuery ??= {}
  runtimeConfig.nuxtUseQuery.telemetry = {
    ...runtimeConfig.nuxtUseQuery.telemetry,
    ...telemetry,
  }
}

function setPublicRuntimeTelemetryConfig(runtimeConfig: Record<string, any>, telemetry: FetchTelemetryRuntimeOptions): void {
  runtimeConfig.public ??= {}
  runtimeConfig.public.nuxtUseQuery ??= {}
  runtimeConfig.public.nuxtUseQuery.telemetry = {
    ...runtimeConfig.public.nuxtUseQuery.telemetry,
    enabled: telemetry.enabled,
  }
}
