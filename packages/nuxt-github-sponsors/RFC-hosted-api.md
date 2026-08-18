# RFC: hosted sponsor API

Status: proposal. Not implemented. Accept or reject before any code lands.

## Problem

Six sites each hold a classic GitHub token, each alias it to a different secret
name, and each run their own cache. One token rotation is six deploys.

## What the module would call

One public GET, owned by this repo:

`GET https://sponsors.harlanzw.com/v1/{login}`

It returns the same `GitHubSponsorsResponse` shape the route returns today, with
raw sponsorships only. Tier grouping and overrides stay in the module, so a site
changes tiers without a redeploy of the hosted API.

## How a site opts in

```ts
export default defineNuxtConfig({
  githubSponsors: {
    login: 'harlan-zw',
    source: 'hosted', // default stays 'token'
  },
})
```

No token, no secret, no workflow change.

## When the hosted API is unreachable

The module returns the existing `upstream-error` state. The page renders empty
and the build still passes. A site that cannot accept an empty list keeps
`source: 'token'`.

## Does a token stay optional

Yes. `source: 'token'` remains supported and stays the default, so a fork or a
different login is never blocked on my deployment.

## Caching and revalidation

The hosted API caches per login for one hour in Cloudflare KV, and serves stale
while it revalidates. The module keeps its own one-day SWR cache, so a hosted
outage is invisible for a day. Under `mode: 'prerender'` the site reads the
hosted API once per build.

## Rate limits

The hosted API allows 60 requests per hour per IP, and serves cached data to
every request beyond that. Upstream GitHub cost is one GraphQL page set per
login per hour, well inside the 5000 point hourly limit.

## Cost

One Cloudflare Worker plus one KV namespace. At six sites the traffic is inside
the free tier. The real cost is that I own an availability promise I do not own
today.

## Recommendation

Reject for now. The per-site token costs one secret per repo, and `tokenEnv`
plus the `upstream-error` state in this PR remove the two problems that actually
hurt. A hosted API trades six cheap secrets for one uptime obligation, one more
deployment to patch, and a new public endpoint to defend. Revisit if the site
count passes about ten, or if token rotation becomes routine.
