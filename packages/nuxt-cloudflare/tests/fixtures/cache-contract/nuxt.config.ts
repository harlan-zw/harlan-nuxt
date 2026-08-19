import cloudflareModule from '@harlan-zw/nuxt-cloudflare'
import { defineNuxtConfig } from 'nuxt/config'

/**
 * The cache contract, exercised against a real Nitro server.
 *
 * Built for `node-server` so the test can boot it. What is under test is the
 * plugin's behaviour inside a real request pipeline, which is where every
 * defect found by review actually lived: header precedence, hook ordering, and
 * what the route-rule handler leaves on the response.
 */
export default defineNuxtConfig({
  compatibilityDate: '2026-08-08',
  modules: [[cloudflareModule, { sourceMaps: false }]],

  // Stands in for `nuxt-skew-protection`, which this package must not depend
  // on. The contract is a shape on runtime config, so a literal is a faithful
  // publisher.
  runtimeConfig: {
    htmlCacheCapabilities: [{
      v: 1,
      by: 'test-publisher',
      documentTtlCeilingSeconds: 600,
      basis: 'retention-days',
      assetRecovery: true,
    }],
  },

  routeRules: {
    '/cached': { headers: { 'cache-control': 'public, s-maxage=300' } },
    '/too-long': { headers: { 'cache-control': 'public, s-maxage=31536000' } },
    '/api/json': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
    '/varies': { headers: { 'cache-control': 'public, s-maxage=300', 'vary': 'Cookie' } },
  },

  nitro: {
    preset: 'node-server',
    cloudflare: {
      // What the module reads to decide whether to register the plugin.
      // `cache` is missing from the wrangler types this nitro version ships,
      // so the cast is a type lag rather than a design choice. The module reads
      // this to decide whether to register the plugin at all.
      wrangler: { name: 'cache-contract-fixture', cache: { enabled: true } } as never,
    },
  },
})
