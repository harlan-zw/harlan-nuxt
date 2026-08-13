# Nitro HTTP benchmark results

Generated: 2026-08-13T04:57:28.065Z

Runtime: Node v24.18.0, AMD Ryzen 9 9900X 12-Core Processor

Method: autocannon v8.0.0, 20s, 3 repetitions, pipelining 1.

| Concurrency | Module | Requests/s | p50 | p99 | Throughput delta | p99 delta |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | disabled | 56725 | 0.0 ms | 0.0 ms | baseline | baseline |
| 1 | enabled | 46564 | 0.0 ms | 0.0 ms | -17.9% | 0.0% |
| 1 | evlog | 41179 | 0.0 ms | 0.0 ms | -27.4% | 0.0% |
| 32 | disabled | 68976 | 0.0 ms | 1.0 ms | baseline | baseline |
| 32 | enabled | 55850 | 0.0 ms | 1.0 ms | -19.0% | 0.0% |
| 32 | evlog | 36864 | 0.0 ms | 2.0 ms | -46.6% | 100.0% |
| 128 | disabled | 77526 | 1.0 ms | 4.0 ms | baseline | baseline |
| 128 | enabled | 72277 | 1.0 ms | 4.0 ms | -6.8% | 0.0% |
| 128 | evlog | 37036 | 3.0 ms | 7.0 ms | -52.2% | 75.0% |

Each cell is the median of all repetitions. See `results.json` for raw autocannon output.

## Built server JavaScript

| Module | Raw | Gzip | Incremental raw | Incremental gzip |
| --- | ---: | ---: | ---: | ---: |
| disabled | 1685165 B | 420436 B | 0 B | 0 B |
| enabled | 1689656 B | 421602 B | 4491 B | 1166 B |
| evlog | 1790383 B | 451435 B | 105218 B | 30999 B |

Size sums every `.mjs` file in the built Nitro server. Gzip compresses each file separately.
