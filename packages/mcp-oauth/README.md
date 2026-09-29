# MCP OAuth

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]

> Framework-free policy rules for an MCP OAuth 2.1 authorization server.

## Why MCP OAuth?

If you want ChatGPT or Claude.ai to reach your MCP server, you must offer RFC 7591 dynamic client registration. Neither connector UI accepts a pre-issued client id. So anyone can mint a client id on your server. The protocol works this way on purpose. Your whole defence then rests on two things: what the authorization endpoint demands, and what the consent page tells the user.

Both are easy to get wrong, and a provider library will not get them right for you:

- 💉 **PKCE only for public clients**: `@cloudflare/workers-oauth-provider` mandates PKCE only for public clients (`validateAuthorizationPkce` throws only when `token_endpoint_auth_method` is `none`). A client that self-declares `client_secret_basic` completes the authorization-code flow with no `code_challenge`. That opens authorization-code **injection** (RFC 9700 §2.1). The attacker cannot redeem a stolen code directly, because the token endpoint verifies the registered secret. But the attacker can inject the code into their own session with the legitimate client. That client's authentication then succeeds on the attacker's behalf. And `createClient` defaults an omitted auth method to `client_secret_basic`, so the unprotected path is the *default* one.
- 🎭 **Self-declared client names**: `client_name` is self-declared, and it is the headline of your consent page. Nothing stops a client that registers as your own product. It renders as first-party over an attacker's callback. A rule on the name alone does not stop it either. The consent page renders a custom-scheme callback as its scheme, so `yourbrand://anything` puts the reserved word in the destination slot.
- 🙈 **Hidden destinations**: If the consent page hides the callback destination, the user cannot tell a real connector from a look-alike.
- 🔓 **Plaintext callbacks**: The provider accepts `http://attacker.example/cb` as a registered callback. It blocks only the actively dangerous schemes. Plaintext transport to a remote host gets through.

MCP OAuth answers each of these with a Policy Rule. The rules come from two production servers, and now live in one place.

It is pure TypeScript with no dependencies: no Nuxt, no Nitro, no h3, no `@cloudflare/workers-types`. It runs on Node 20+ and workers. Use it beside a provider such as [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). It does not replace one.

## Features

- 🔐 **Mandatory PKCE**: Every client must send an S256 challenge, confidential clients included, so an injected authorization code fails.
- 🪪 **Consent identity**: A client cannot pose as your product through its name or a custom callback scheme.
- 🧭 **Readable destinations**: The consent page shows where the code goes, and a loopback callback reads as "this computer".
- 🛣️ **Path-normalising routes**: `POST /mcp/` cannot skip bearer authentication through a trailing slash.
- 🎟️ **Scope-bound refresh tokens**: A user who declines `offline_access` gets no refresh token.
- 🧱 **Consent-page secrets**: The CSRF token and the CSP nonce can never share a value.
- 📦 **No dependencies**: The same rules run on Node 20+ and workers, beside any provider.

## Installation

```bash
pnpm add @harlan-zw/mcp-oauth
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/mcp-oauth
> ```

## What you get

| Export | What it gives you |
| --- | --- |
| `requireMcpPkce` | Mandatory S256 for every client, confidential included, plus the RFC 7636 challenge shape. |
| `assessMcpClientIdentity` | One decision over a client's whole claimed identity: name, callback scheme, callback security, and whether anything verified it. |
| `assessMcpClientName` | Refuses a client claiming a brand you reserve. Skeleton comparison, so punctuation, case, width, diacritics and zero-width characters do not evade it. Entries match as substrings, so reserve the full brand. |
| `assessMcpCallbackScheme` | The same rule applied to a custom-scheme callback, which the consent page renders in place of a host. |
| `assessMcpRedirectUri` | Refuses plaintext http to a remote host and a fragment; allows loopback http per RFC 8252. |
| `describeMcpCallbackDestination` | The callback as a human reads it. Loopback becomes "this computer". **HTML-escape the result.** |
| `isMcpLoopbackCallback`, `isMcpLoopbackUrl` | A real loopback callback over all of `127.0.0.0/8`, not a `127.0.0.1.attacker.example` look-alike. |
| `isMcpHostOwnedBy` | Anchored host ownership. `host.endsWith(root)` hands `evilclaude.ai` the `claude.ai` treatment; this does not. |
| `grantedMcpScopes` | Intersects the request with your policy, so a read-only client never receives a write scope. |
| `mcpRefreshTokenTtl` | The refresh-token lifetime a granted scope set earned: `0` when `offline_access` was not granted. |
| `resolveMcpOAuthIdentity` | RFC 8707 / 8414 / 9728 identifiers derived from the request, so staging advertises itself. |
| `matchMcpOAuthRoute` | Method-aware, **path-normalising** classification of your protocol, discovery and resource paths. |
| `normalizeMcpPath`, `mcpNameSkeleton` | The two normalisers the rules above are built on, exported for your own comparisons. |
| `createMcpBearerChallenge`, `mcpBearerErrorStatus`, `readBearerToken` | The RFC 6750 challenge carrying the RFC 9728 pointer a connector triggers on, with both interpolations sanitised. |
| `createMcpConsentSecrets`, `verifyMcpCsrfToken`, `createMcpRandomToken` | Consent-page secrets, minted as a pair so the CSRF token and the CSP nonce cannot be the same value. |
| `createMcpConsentFormAction`, `createMcpConsentCacheControl` | Consent-page CSP and cache headers. |
| `exceedsMcpBodyLimit`, `MCP_BODY_LIMIT_BYTES` | A declared-length body cap for a request you cannot drain. |
| `AUTHORIZATION_SERVER_WELL_KNOWN`, `PROTECTED_RESOURCE_WELL_KNOWN`, `OPENID_CONFIGURATION_WELL_KNOWN` | The discovery paths `matchMcpOAuthRoute` classifies. |

## Decision style

Each rule that can refuse something returns a tagged decision. None of them throws. The other exports are derivations and predicates that return a plain string, number, or boolean.

Two exceptions:

- `createMcpRandomToken` reads `crypto` and `btoa`, unless you inject its randomness.
- `resolveMcpOAuthIdentity` throws on an unparseable `requestUrl`, because no honest fallback identity exists. Pass it `request.url`, which is always a valid URL.

```ts
import { requireMcpPkce } from '@harlan-zw/mcp-oauth'

const pkce = requireMcpPkce(authRequest)
if (pkce._tag === 'Err') {
  // missing_code_challenge | weak_code_challenge_method | malformed_code_challenge
  return redirectError(authRequest, 'invalid_request', 'PKCE with S256 is required.')
}
```

Put the PKCE rule **before** your login redirect. Then a flow that cannot complete does not first send the user through their identity provider. Redirect an error only to a `redirect_uri` that your provider already matched against the client's registered set. Any other target is an open redirect.

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

**Call this at consent time, and not only at registration.** A provider's registration callback covers RFC 7591 clients only. A Client-ID Metadata Document (CIMD) client uses an https client id, and that id's own host serves its metadata. This client never passes through registration. So an attacker skips a registration-only rule by choosing a client id instead of POSTing to `/register`. The CIMD rules also do not limit that document's `redirect_uris` to the client-id host. If you enable CIMD, run this rule on the resolved client before you render anything.

CIMD does give you one signal worth trusting: the client id is an https URL whose host actually served the document. `ownedHosts` matches that host. This is why a verified first-party client may use your reserved name.

`verified` requires **both** the client id host and the callback host to be yours. The id proves who published the metadata. It says nothing about where the code goes. For a first-party client registered through DCR, the id is opaque, so set `trusted: true` on the claim instead.

Always show the escaped destination on the page. If `verification` says unverified, mark the client unverified.

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

Nothing here hardcodes a path or an origin. If an edge route table splits your deployment across Workers, nest the endpoints under a prefix that table already binds. If you do not offer dynamic registration, set `register: null`. This changes routing only. Your provider's setting decides whether DCR is *advertised*.

`matchMcpOAuthRoute` normalises the path before it compares. Security depends on this. In one of the source servers, a raw `===` path compare was an authentication bypass. `POST /mcp/` classified as "not the protected resource", so the caller skipped bearer authentication. The router then folded the trailing slash and served the request from the MCP handler anyway.

Treat `Ignore` as "this is not mine". Treat `WellKnownNotFound` as "answer a JSON 404". A client that probes discovery parses the body as JSON. It reads an HTML error page as an invalid OAuth response, and not as "no OIDC here".

## Identity and audience

```ts
const identity = resolveMcpOAuthIdentity(request.url, endpoints, configuredOrigin)
```

If `configuredOrigin` is unset, the identity comes from the request URL. The runtime builds that URL from the `Host` header. **The attacker controls that header.** A poisoned `Host` points the advertised issuer, the RFC 8707 resource, and the `resource_metadata` pointer in your 401 at the attacker's server. Any cache in front of those responses passes that on. Compare `url.host` with a known set, or set `configuredOrigin`. Deriving is the right default, because a hardcoded origin breaks every preview deploy. You still need the host allowlist.

Feed `identity.resource` into your provider's resource metadata. If the provider does not know its canonical resource, it accepts any `resource` a client sends. It then mints tokens with that audience. You silently lose RFC 8707 validation and audience binding.

## Scopes

```ts
const granted = grantedMcpScopes(authRequest.scope, {
  required: ['mcp:read'],
  optional: ['mcp:write', 'offline_access'],
})
```

The granted list comes back deduplicated and in policy order. So it is stable across clients, and you can compare it once it is stored on a grant.

Intersecting `offline_access` is not enough on its own. A provider mints a refresh token whenever its TTL is non-zero, and it ignores scope. So a user who declined offline access still gets a 30-day credential, which your consent page promised against.

With `@cloudflare/workers-oauth-provider`, only `tokenExchangeCallback` can set the lifetime per grant, on the authorization-code exchange. `completeAuthorization` has no TTL field, so put the value here:

```ts
const providerOptions = {
  // ...
  tokenExchangeCallback: ({ grantType, scope }) => {
    // Only honoured on the code exchange; ignored on a refresh.
    if (grantType !== 'authorization_code')
      return undefined
    return { refreshTokenTTL: mcpRefreshTokenTtl(scope, { ttl: 2_592_000 }) }
  },
}
```

A TTL of `0` skips the mint entirely and omits `refresh_token` from the response.

## What this package does not own

The consent page's markup and copy, the grant payload shape, token storage, and the provider wiring. These depend on your product, so they belong in your app.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/mcp-oauth/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fmcp-oauth/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/mcp-oauth

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fmcp-oauth.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/mcp-oauth

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/mcp-oauth/LICENSE.md
