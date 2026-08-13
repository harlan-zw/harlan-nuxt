# Production CPU profile

Generated on 2026-08-13 with Node 24.18.0 and an AMD Ryzen 9 9900X.

Each scenario creates and serializes three million five Field records with real clocks and request IDs.

| Scenario | Wall time | Maximum RSS |
| --- | ---: | ---: |
| raw JSON | 3.39 s | 64.1 MB |
| nuxt-wide-events | 3.38 s | 64.8 MB |
| evlog 2.26.0 | 5.02 s | 130.6 MB |

The nuxt-wide-events result is within 0.3 percent of raw JSON. Evlog took 49 percent longer and used twice the memory.

The flamegraph shows native UUID creation, ISO timestamp formatting, and JSON serialization as the shared cost. `emitWideEvent` is the remaining package frame. Evlog also spends time in `mergeInto`, audit emission, object cloning, and weak collection writes.

## Built Nitro profile

A second 0x profile drove the built Nitro server with 32 connections for ten seconds.
The baseline handled 95,898 requests/s. The enabled module handled 86,461 requests/s, a 9.8 percent profiling overhead.
Neither `startWideEvent` nor `emitWideEvent` appeared as a self-time frame. Native UUID creation was the visible added frame.

Reproduce each interactive flamegraph from the built package:

```sh
pnpm build
npx 0x --tree-debug --output-dir .profiles/wide bench/profile.mjs wide 3000000
npx 0x --tree-debug --output-dir .profiles/evlog bench/profile.mjs evlog 3000000
npx 0x --tree-debug --output-dir .profiles/raw bench/profile.mjs raw 3000000
```

Treat wall time as a local diagnostic. Use the Vitest benchmark and Nitro HTTP matrix for repeated comparisons.

## Field ownership optimization

A paired profile serialized three million fresh 20 Field records with fixed clocks. The optimized build reduced wall time from 6.12 to 2.60 seconds and maximum RSS from 69.3 to 66.1 MB.

Package self samples fell from 1,600 to 440. Garbage collection samples fell from 166 to 51. The build now transfers validated inline Field literals into the Wide Event. Public runtime calls still copy their input.

```sh
npx 0x --tree-debug --output-dir .profiles/wide-fixed bench/profile.mjs wide-fixed 3000000
```
