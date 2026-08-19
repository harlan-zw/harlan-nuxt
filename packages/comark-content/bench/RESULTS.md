# Benchmark results

Environment: Node 24.17.0, pnpm 11.2.1, ten isolated samples per variant.
Workload: the `harlanzw.com` Markdown collection and production application.

| Metric | Nuxt Content | comark-content | Change |
| --- | ---: | ---: | ---: |
| Cold parse and index | 1,148.07 ms | 78.06 ms | -93.2% |
| Incremental parse and index | 300.28 ms | 33.74 ms | -88.8% |
| `nuxt prepare` | 3,378.79 ms | 3,090.54 ms | -8.5% |
| Production build | 37,163.12 ms | 26,017.86 ms | -30.0% |
| Incremental production build | 32,371.54 ms | 24,657.86 ms | -23.8% |
| SSR render | 19.88 ms | 18.86 ms | -5.2% |
| Client JavaScript | 1,552,202 B | 942,840 B | -39.3% |
| Content client JavaScript | 519,855 B | 101,330 B | -80.5% |
| Nitro server output | 7,021,610 B | 6,401,947 B | -8.8% |
| Installed dependencies | 974,969,330 B | 941,532,126 B | -3.4% |

The candidate passes both primary gates and every no-regression gate. Cold parse and index uses 6.8% of baseline time. Content-related client JavaScript uses 19.5% of baseline bytes.
Raw samples: [`baseline.json`](./results/baseline.json) and [`candidate.json`](./results/candidate.json).

Run `pnpm --filter @harlan-zw/comark-content bench -- --variant baseline` or replace `baseline` with `candidate`.
