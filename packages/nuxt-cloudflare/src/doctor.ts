import type { WranglerDiagnostic, WranglerDiagnosticOptions } from './wrangler'
import type { ReadProjectWranglerOptions } from './wrangler-reader'
import { dirname, resolve } from 'pathe'
import { diagnoseWranglerSourceConfigs, discoverWranglerSourceConfigs } from './diagnostics'
import { diagnoseStaticAssetRules, readStaticAssetRuleFiles } from './static-assets'
import { diagnoseWranglerConfig } from './wrangler'
import { readProjectWranglerConfig } from './wrangler-reader'

export interface DiagnoseWranglerProjectOptions extends ReadProjectWranglerOptions, WranglerDiagnosticOptions {}

export interface WranglerProjectDiagnostics {
  configPath: string | undefined
  diagnostics: WranglerDiagnostic[]
  sourceConfigPaths: string[]
}

export function diagnoseWranglerProject(options: DiagnoseWranglerProjectOptions): WranglerProjectDiagnostics {
  const sourceConfigPaths = discoverWranglerSourceConfigs(options.cwd, options.config)
  const loaded = readProjectWranglerConfig(options)
  if (loaded._tag === 'invalid') {
    return {
      configPath: loaded.path,
      diagnostics: [{
        _tag: 'error',
        code: 'wrangler-config-unreadable',
        message: 'Wrangler could not read the effective config. Build Nuxt again or run Wrangler locally for validation details.',
        sourcePath: loaded.path ?? 'wrangler config',
      }, ...diagnoseWranglerSourceConfigs(sourceConfigPaths)],
      sourceConfigPaths,
    }
  }
  if (!loaded.path && sourceConfigPaths.length === 0) {
    return {
      configPath: undefined,
      diagnostics: [{
        _tag: 'error',
        code: 'wrangler-config-missing',
        message: 'No authored or generated Wrangler config exists. Build Nuxt before running doctor.',
        sourcePath: options.cwd,
      }],
      sourceConfigPaths,
    }
  }
  return {
    configPath: loaded.path,
    diagnostics: [
      ...diagnoseWranglerConfig(loaded.config, { ...options, generated: loaded.generated, normalized: true }),
      ...diagnoseWranglerSourceConfigs(sourceConfigPaths),
      ...diagnoseStaticAssetRules(readStaticAssetRuleFiles(resolveAssetsDirectory(loaded.path, loaded.config.assets?.directory))),
    ],
    sourceConfigPaths,
  }
}

/** The assets directory is relative to the config that names it. Without one there is nothing to count. */
function resolveAssetsDirectory(configPath: string | undefined, directory: string | undefined): string {
  if (!configPath || !directory)
    return ''
  return resolve(dirname(configPath), directory)
}
