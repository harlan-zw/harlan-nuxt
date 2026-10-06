import type { NitroApp } from 'nitro/types'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore optional peer. This adapter runs only on Cloudflare with Sentry enabled.
import { captureException, getDefaultIntegrations } from '@sentry/cloudflare'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore optional peer. This adapter runs only on Cloudflare with Sentry enabled.
import { wrapRequestHandler } from '@sentry/cloudflare/request'
import { useNitroHooks } from 'nitro/app'

type PlatformRequest = Request & { runtime?: { cloudflare?: { context?: Parameters<typeof wrapRequestHandler>[0]['context'] } } }

export function sentryCloudflareNitroPlugin(options: Parameters<typeof wrapRequestHandler>[0]['options']) {
  return (app: NitroApp) => {
    const fetch = app.fetch.bind(app)
    app.fetch = (request) => {
      const req = request as PlatformRequest
      return wrapRequestHandler({
        options: { defaultIntegrations: getDefaultIntegrations(options), ...options },
        request: req,
        context: req.runtime?.cloudflare?.context,
        captureErrors: false,
      }, () => fetch(req))
    }
    useNitroHooks().hook('error', (error) => {
      const status = (error as { status?: number, statusCode?: number }).status
        ?? (error as { statusCode?: number }).statusCode
      if (status !== undefined && status >= 300 && status < 500)
        return
      captureException(error, { mechanism: { handled: false, type: 'auto.function.nuxt.nitro' } })
    })
  }
}
