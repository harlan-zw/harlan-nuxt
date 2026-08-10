import { defineProject } from 'vitest/config'

// The `nitro` vitest project: integration tests that run against a real,
// built Nuxt server (nitropack v2) via @nuxt/test-utils `setup` + `$fetch`.
// Suites pick their fixture app per `setup({ rootDir })`. Files are matched by
// the `.nitro.test.ts` suffix so they stay out of the happy-dom `unit` project.
export default defineProject({
  test: {
    name: 'nitro',
    // Globs resolve relative to this config file's dir (`tests/`).
    include: ['**/*.nitro.test.ts'],
    environment: 'node',
    // Building + booting the Nuxt fixture is slow; give setup room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
