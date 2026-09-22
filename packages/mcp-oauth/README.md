# @harlan-zw/mcp-oauth

Framework-free Policy Rules for an MCP OAuth 2.1 authorization server: mandatory PKCE, consent identity, CSRF, bearer challenges.

Pure TypeScript with no dependencies: no Nuxt, no Nitro, no h3, no `@cloudflare/workers-types`. Runs on Node 20+ and workers. It pairs with a provider such as [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider); it does not replace one.

## Why this exists

An MCP server that wants to be reachable from ChatGPT or Claude.ai has to offer RFC 7591 dynamic client registration, because neither connector UI accepts a pre-issued client id. So anyone can mint a client id on your server. That is the protocol working as designed, and it moves the whole defence onto two things: what the authorization endpoint insists on, and what the consent page tells the user.

Both are easy to get wrong, and a provider library will not get them right for you:

- `@cloudflare/workers-oauth-provider` mandates PKCE only for public clients. A client that self-declares `client_secret_basic` can complete the authorization-code flow with no `code_challenge`, and its code is then bearer-only. Under open registration, "confidential" is a self-declaration, not a trust signal.
- `client_name` is self-declared too, and it is the headline of your consent page. Nothing stops a client registering as your own product and rendering as first-party over an attacker's callback.
- A consent page that does not show the callback destination gives the user no way to tell a real connector from a look-alike.

These rules are the answers, extracted from two production servers so they exist in one place rather than two.

## What you get

| Export | What it gives you |
| --- | --- |
| `requireMcpPkce` | Mandatory S256 for every client, confidential included. |
| `assessMcpClientName` | Refuses a client registering under a brand name you reserve, spacing and casing included. |
| `describeMcpCallbackDestination` | The callback host as a human reads it, for the consent page. Loopback becomes "this computer". |
| `isMcpLoopbackCallback` | A real loopback callback, not a `127.0.0.1.attacker.example` look-alike. |
| `grantedMcpScopes` | Intersects the request with your policy, so a read-only client never receives a write scope. |
| `resolveMcpOAuthIdentity` | RFC 8707 / 8414 / 9728 identifiers derived from the request, so staging advertises itself. |
| `matchMcpOAuthRoute` | Method-aware classification of your protocol, discovery and resource paths. |
| `createMcpBearerChallenge`, `mcpBearerErrorStatus`, `readBearerToken` | The RFC 6750 challenge carrying the RFC 9728 pointer a connector triggers on. |
| `createMcpCsrfToken`, `createMcpCspNonce`, `verifyMcpCsrfToken` | Separate consent-page secrets, compared without an early return. |
| `createMcpConsentFormAction`, `createMcpConsentCacheControl` | Consent-page CSP and cache headers. |
| `exceedsMcpBodyLimit` | A declared-length body cap for a request you cannot drain. |

## Decision style

Every rule is request facts in, a tagged Policy Decision out. Nothing throws, nothing does I/O, nothing reads a global.

```ts
import { requireMcpPkce } from '@harlan-zw/mcp-oauth'

const pkce = requireMcpPkce(authRequest)
if (pkce._tag === 'Err') {
  // `missing_code_challenge` or `weak_code_challenge_method`
  return redirectError(authRequest, 'invalid_request', 'PKCE with S256 is required.')
}
```

Put the PKCE rule **before** your login redirect. A flow that cannot complete should not first cost the user a round trip through their identity provider.

## Consent identity

```ts
import { assessMcpClientName, describeMcpCallbackDestination } from '@harlan-zw/mcp-oauth'

// At registration, in the provider's `clientRegistrationCallback`.
const assessed = assessMcpClientName(clientMetadata.client_name, { reservedNames: ['Acme Cloud'] })
if (assessed._tag === 'Err') {
  return { code: 'invalid_client_metadata', description: 'Register under your own product name.' }
}

// On the consent page.
describeMcpCallbackDestination('https://chatgpt.com/connector/oauth/x') // 'chatgpt.com'
describeMcpCallbackDestination('http://127.0.0.1:8787/callback') // 'this computer'
describeMcpCallbackDestination('cursor://anysphere.cursor-mcp/oauth/callback') // 'cursor'
```

Reserved names are words, not patterns. `['Acme Cloud']` rejects `Acme Cloud`, `acmecloud` and `ACME  cloud` alike, and a regex metacharacter in the word is matched literally, so a caller cannot hand you a backtracking risk.

Show the destination on the page unconditionally, and mark the client unverified whenever nothing independent confirmed it. Verify by checking the client id or the callback against a host the brand owns, never the name.

## Endpoints are configuration

```ts
import type { McpOAuthEndpoints } from '@harlan-zw/mcp-oauth'

// A single Worker owning the apex.
const endpoints: McpOAuthEndpoints = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  resource: '/mcp',
}
```

Nothing here hardcodes a path or an origin. A deployment split across Workers by an edge route table has to nest its endpoints under a prefix that table already binds, and a server with production literals compiled in advertises production URLs from every preview deploy, which makes those deploys unfinishable. Set `register: null` if you do not offer dynamic registration.

## Scopes

```ts
import { grantedMcpScopes } from '@harlan-zw/mcp-oauth'

const granted = grantedMcpScopes(authRequest.scope, {
  required: ['mcp:read'],
  optional: ['mcp:write', 'offline_access'],
})
```

The granted list comes back in policy order, not request order, so it is stable across clients and comparable once stored on a grant.

## What this package does not own

The consent page's markup and copy, the grant payload shape, token storage, and the provider wiring. Those know what your product is, and they belong in your app.

## License

MIT
