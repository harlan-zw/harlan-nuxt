# Nitro HTTP benchmark results

Generated: 2026-08-13T04:28:12.023Z

Runtime: Node v24.18.0, AMD Ryzen 9 9900X 12-Core Processor

Method: autocannon autocannon v8.0.0
node v24.18.0, 1s, 1 repetitions, pipelining 1.

| Concurrency | Module | Requests/s | p50 | p99 | Throughput delta | p99 delta |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | disabled | 44848 | 0.0 ms | 0.0 ms | baseline | baseline |
| 1 | enabled | 43952 | 0.0 ms | 0.0 ms | -2.0% | NaN% |
| 32 | disabled | 34768 | 0.0 ms | 6.0 ms | baseline | baseline |
| 32 | enabled | 66336 | 0.0 ms | 1.0 ms | 90.8% | -83.3% |
| 128 | disabled | 63920 | 1.0 ms | 6.0 ms | baseline | baseline |
| 128 | enabled | 61424 | 1.0 ms | 4.0 ms | -3.9% | -33.3% |

Each cell is the median of all repetitions. See `results.json` for raw autocannon output.
