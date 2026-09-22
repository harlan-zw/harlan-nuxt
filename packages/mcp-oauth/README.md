# @harlan-zw/mcp-oauth

Framework-free policy rules for an MCP OAuth 2.1 authorization server: mandatory PKCE, consent identity, CSRF, bearer challenges.

Pure TypeScript with no dependencies: no Nuxt, no Nitro, no h3, no `@cloudflare/workers-types`. Runs on Node 20+ and workers. It pairs with a provider such as [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider); it does not replace one.

## Why this exists

An MCP server that wants to be reachable from ChatGPT or Claude.ai has to offer RFC 7591 dynamic client registration, because neither connector UI accepts a pre-issued client id. So anyone can mint a client id on your server. That is the protocol working as designed, and it moves the whole defence onto two things: what the authorization endpoint insists on, and what the consent page tells the user.

Both are easy to get wrong, and a provider library will not get them right for you:

- `@cloudflare/workers-oauth-provider` mandates PKCE only for public clients (`validateAuthorizationPkce` throws only when `token_endpoint_auth_method` is `none`). A client that self-declares `client_secret_basic` completes the authorization-code flow with no `code_challenge`. What that costs is authorization-code **injection** (RFC 9700 §2.1): the attacker cannot redeem a stolen code directly, because the token endpoint does verify the registered secret, but they can inject it into their own session with the legitimate client, whose client authentication then succeeds on their behalf. And `createClient` defaults an omitted auth method to `client_secret_basic`, so the unprotected path is the *default* one.
- `client_name` is self-declared, and it is the headline of your consent page. Nothing stops a client registering as your own product and rendering as first-party over an attacker's callback. Neither does guarding the name alone: a custom-scheme callback is rendered as its scheme, so `yourbrand://anything` puts the reserved word in the destination slot instead.
- A consent page that does not show the callback destination gives the user no way to tell a real connector from a look-alike.
- The provider accepts `http://attacker.example/cb` as a registered callback. It blocks only the actively dangerous schemes, not plaintext transport to a remote host.

These rules are the answers, extracted from two production servers so they exist in one place rather than two.

## What you get

| Export | What it gives you |
| --- | --- |
| `requireMcpPkce` | Mandatory S256 for every client, confidential included, plus the RFC 7636 challenge shape. |
| `assessMcpClientIdentity` | One decision over a client's whole claimed identity: name, callback scheme, callback security, and whether anything verified it. |
| `assessMcpClientName` | Refuses a client claiming a brand you reserve. Skeleton comparison, so punctuation, case, width, diacritics and zero-width characters do not evade it. |
| `assessMcpCallbackScheme` | The same rule applied to a custom-scheme callback, which the consent page renders in place of a host. |
| `assessMcpRedirectUri` | Refuses plaintext http to a remote host and a fragment; allows loopback http per RFC 8252. |
| `describeMcpCallbackDestination` | The callback as a human reads it. Loopback becomes "this computer". **HTML-escape the result.** |
| `isMcpLoopbackCallback`, `isMcpLoopbackUrl` | A real loopback callback over all of `127.0.0.0/8`, not a `127.0.0.1.attacker.example` look-alike. |
| `isMcpHostOwnedBy` | Anchored host ownership. `host.endsWith(root)` hands `evilclaude.ai` the `claude.ai` treatment; this does not. |
| `grantedMcpScopes` | Intersects the request with your policy, so a read-only client never receives a write scope. |
| `mcpRefreshTokenTtl` | Withholds a refresh token when `offline_access` was not granted. |
| `resolveMcpOAuthIdentity` | RFC 8707 / 8414 / 9728 identifiers derived from the request, so staging advertises itself. |
| `matchMcpOAuthRoute` | Method-aware, **path-normalising** classification of your protocol, discovery and resource paths. |
| `normalizeMcpPath`, `mcpNameSkeleton` | The two normalisers the rules above are built on, exported for your own comparisons. |
| `createMcpBearerChallenge`, `mcpBearerErrorStatus`, `readBearerToken` | The RFC 6750 challenge carrying the RFC 9728 pointer a connector triggers on, with both interpolations sanitised. |
| `createMcpConsentSecrets`, `verifyMcpCsrfToken`, `createMcpRandomToken` | Consent-page secrets, minted as a pair so the CSRF token and the CSP nonce cannot be the same value. |
| `createMcpConsentFormAction`, `createMcpConsentCacheControl` | Consent-page CSP and cache headers. |
| `exceedsMcpBodyLimit`, `MCP_BODY_LIMIT_BYTES` | A declared-length body cap for a request you cannot drain. |
| `AUTHORIZATION_SERVER_WELL_KNOWN`, `PROTECTED_RESOURCE_WELL_KNOWN`, `OPENID_CONFIGURATION_WELL_KNOWN` | The discovery paths `matchMcpOAuthRoute` classifies. |

## Decision style

The rules that can refuse something return a tagged decision. Nothing throws and nothing does I/O; the only global read is the CSRF entropy source, which is injectable. The remaining exports are derivations and predicates that return a plain string, number or boolean.

```ts
import { requireMcpPkce } from '@harlan-zw/mcp-oauth'

const pkce = requireMcpPkce(authRequest)
if (pkce._tag === 'Err') {
  // missing_code_challenge | weak_code_challenge_method | malformed_code_challenge
  return redirectError(authRequest, 'invalid_request', 'PKCE with S256 is required.')
}
```

Put the PKCE rule **before** your login redirect. A flow that cannot complete should not first cost the user a round trip through their identity provider. And redirect an error only to a `redirect_uri` your provider has already matched against the client's registered set, or you have built an open redirect.

## Consent identity

```ts
import { assessMcpClientIdentity } from '@harlan-zw/mcp-oauth'

const policy = {
  reservedNames: ['Acme Cloud'],
  ownedHosts: ['acmecloud.com'],
}

const decision = assessMcpClientIdentity(
  { clientId: client.clientId, clientName: client.clientName, redirectUri: authRequest.redirectUri },
  policy,
)
if (decision._tag === 'Err')
  return refuse(decision.reason)

renderConsent({ unverified: decision.verification === 'unverified' })
```

**Call this at consent time, not only at registration.** A provider's registration callback covers RFC 7591 clients only. A Client-ID Metadata Document client — an https client id whose own host serves its metadata — never passes through registration, so a registration-only check is bypassed by choosing a client id instead of POSTing to `/register`. Nothing in the CIMD rules constrains that document's `redirect_uris` to the client-id host either. If you enable CIMD, run this rule on the resolved client before you render anything.

CIMD does give you the one signal worth trusting: the client id is an https URL whose host actually served the document. That is what `ownedHosts` checks, and why a verified first-party client is allowed to use your reserved name.

Show the destination on the page unconditionally, escaped, and mark the client unverified whenever `verification` says so.

## Endpoints are configuration

```ts
import type { McpOAuthEndpoints } from '@harlan-zw/mcp-oauth'

const endpoints: McpOAuthEndpoints = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  resource: '/mcp',
}
```

Nothing here hardcodes a path or an origin. A deployment split across Workers by an edge route table has to nest its endpoints under a prefix that table already binds. Set `register: null` if you do not offer dynamic registration — note that this only affects routing; whether DCR is *advertised* is your provider's setting.

`matchMcpOAuthRoute` normalises the path before comparing, and that is load-bearing rather than tidy. Comparing a raw path with `===` was an authentication bypass in one of the servers this came from: `POST /mcp/` classified as "not the protected resource", the caller skipped the bearer check, and the router folded the trailing slash and served the request off the MCP handler anyway.

Treat `Ignore` as "this is not mine" and `WellKnownNotFound` as "answer a JSON 404" — a client probing discovery parses the body as JSON, so an HTML error page surfaces as an invalid OAuth response rather than "no OIDC here".

## Identity and audience

```ts
const identity = resolveMcpOAuthIdentity(request.url, endpoints, configuredOrigin)
```

With `configuredOrigin` unset this derives from the request URL, which is built from the `Host` header. **That header is attacker-controlled.** A poisoned `Host` steers the advertised issuer, the RFC 8707 resource and the `resource_metadata` pointer in your 401 at a server of the attacker's choosing, and any cache in front of those responses passes it on. Validate `url.host` against a known set, or set `configuredOrigin`. Deriving is the right default because hardcoding makes every preview deploy unfinishable; it is not a substitute for a host check.

Feed `identity.resource` into your provider's resource metadata. A provider that is not told its canonical resource accepts whatever `resource` a client sends and mints tokens with that audience, so RFC 8707 validation and audience binding are both silently lost.

## Scopes

```ts
const granted = grantedMcpScopes(authRequest.scope, {
  required: ['mcp:read'],
  optional: ['mcp:write', 'offline_access'],
})
```

The granted list comes back in policy order and deduplicated, so it is stable across clients and comparable once stored on a grant.

Intersecting `offline_access` is not enough on its own: a provider mints a refresh token whenever its TTL is non-zero, without consulting scope. Pass `mcpRefreshTokenTtl(granted.scopes, { ttl })` per grant at the code exchange, or a user who declined offline access still issues a 30-day credential and your consent page promised otherwise.

## What this package does not own

The consent page's markup and copy, the grant payload shape, token storage, and the provider wiring. Those know what your product is, and they belong in your app.

## License

MIT
