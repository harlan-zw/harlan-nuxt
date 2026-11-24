/**
 * Reads the sponsors token per request, never at build, so no deploy carries it.
 *
 * `tokenEnv` covers a prerender, which runs with the build env, and a Node or
 * Vercel server. `token` is the runtime config slot that Nitro fills from
 * `NUXT_GITHUB_SPONSORS_TOKEN`, the Worker secret name, when `tokenEnv` differs.
 */
export function readSponsorToken(
  env: Record<string, string | undefined>,
  config: { tokenEnv?: string, token?: string },
): string | undefined {
  const fromEnv = config.tokenEnv ? env[config.tokenEnv]?.trim() : undefined
  return fromEnv || config.token?.trim() || undefined
}
