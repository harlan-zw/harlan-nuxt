import { defineEventHandler } from '#imports'

/**
 * Stands in for the sitemap source @nuxt/content used to serve.
 *
 * Comark contributes its URLs through the `sitemap:input` nitro hook, so this
 * source has nothing to add. It exists so a surviving `@nuxt/content@v3:urls`
 * source resolves to an empty list instead of 404ing the whole sitemap route.
 */
export default defineEventHandler(() => [])
