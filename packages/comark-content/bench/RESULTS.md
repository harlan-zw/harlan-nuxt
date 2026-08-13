# Benchmark results

Environment: Node 24.17.0, pnpm 11.2.1, ten isolated samples per variant.
Workload: the `harlanzw.com` Markdown collection and production application.

| Metric | Nuxt Content | comark-content | Change |
| --- | ---: | ---: | ---: |
| Cold parse and index | 1,148.07 ms | 47.10 ms | -95.9% |
| Incremental parse and index | 300.28 ms | 16.27 ms | -94.6% |
| `nuxt prepare` | 3,378.79 ms | 3,272.36 ms | -3.2% |
| Production build | 37,163.12 ms | 26,544.30 ms | -28.6% |
| Incremental production build | 32,371.54 ms | 24,741.35 ms | -23.6% |
| SSR render | 19.88 ms | 19.50 ms | -1.9% |
| Client JavaScript | 1,552,202 B | 941,938 B | -39.3% |
| Content client JavaScript | 519,855 B | 19,900 B | -96.2% |
| Nitro server output | 7,021,610 B | 6,447,350 B | -8.2% |
| Installed dependencies | 974,969,330 B | 880,052,111 B | -9.7% |

The candidate passes both main gates. No tracked metric regressed.
Raw samples: [`baseline.json`](./results/baseline.json) and [`candidate.json`](./results/candidate.json).

Run `pnpm --filter @harlan-zw/comark-content bench -- --variant baseline` or replace `baseline` with `candidate`.
