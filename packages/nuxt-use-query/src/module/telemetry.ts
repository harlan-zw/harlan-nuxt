import type { FetchTelemetryRuntimeOptions } from '../runtime/telemetry'
import { addServerPlugin } from '@nuxt/kit'
import { consola } from 'consola'
import {
  collectFetchTelemetryOptionWarnings,
  DEFAULT_FETCH_TELEMETRY_OPTIONS,
  normalizeFetchTelemetryOptions,
} from '../runtime/telemetry'

export type ModuleTelemetryOptions = boolean | Partial<FetchTelemetryRuntimeOptions>

export interface ModuleRuntimeConfig {
  nuxtUseQuery?: {
    telemetry?: Partial<FetchTelemetryRuntimeOptions>
  }
  public?: {
    nuxtUseQuery?: {
      telemetry?: Pick<FetchTelemetryRuntimeOptions, 'enabled'>
    }
  }
}

export function setupFetchTelemetryModule(
  input: ModuleTelemetryOptions | undefined,
  runtimeConfig: ModuleRuntimeConfig,
  serverPlugin: string,
): void {
  const telemetry = resolveModuleTelemetryOptions(input)
  setPublicRuntimeTelemetryConfig(runtimeConfig, telemetry)
  if (!telemetry.enabled)
    return

  reportTelemetryOptionWarnings(telemetry)
  setRuntimeTelemetryConfig(runtimeConfig, telemetry)
  addServerPlugin(serverPlugin)
}

/**
 * Surface unreachable telemetry configuration at build time. A dead threshold
 * looks identical to a healthy site: both report nothing.
 */
function reportTelemetryOptionWarnings(telemetry: FetchTelemetryRuntimeOptions): void {
  const logger = consola.withTag('nuxt-use-query')
  for (const warning of collectFetchTelemetryOptionWarnings(normalizeFetchTelemetryOptions(telemetry)))
    logger.warn(warning.message)
}

function resolveModuleTelemetryOptions(input: ModuleTelemetryOptions | undefined): FetchTelemetryRuntimeOptions {
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

function setRuntimeTelemetryConfig(runtimeConfig: ModuleRuntimeConfig, telemetry: FetchTelemetryRuntimeOptions): void {
  runtimeConfig.nuxtUseQuery ??= {}
  runtimeConfig.nuxtUseQuery.telemetry = {
    ...runtimeConfig.nuxtUseQuery.telemetry,
    ...telemetry,
  }
}

function setPublicRuntimeTelemetryConfig(runtimeConfig: ModuleRuntimeConfig, telemetry: FetchTelemetryRuntimeOptions): void {
  runtimeConfig.public ??= {}
  runtimeConfig.public.nuxtUseQuery ??= {}
  runtimeConfig.public.nuxtUseQuery.telemetry = {
    ...runtimeConfig.public.nuxtUseQuery.telemetry,
    enabled: telemetry.enabled,
  }
}
