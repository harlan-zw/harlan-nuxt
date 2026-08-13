# Core benchmark results

Generated on 2026-08-13 with Node v24.18.0 and an AMD Ryzen 9 9900X.

Each task warmed for 500 milliseconds and 1,000 iterations. Each measurement ran for two seconds.
Output destinations performed no terminal, file, or network I/O.
Each value is the median of five independent runs.

## Production lifecycle with JSON serialization

| Fields | Runtime | Operations/s | Relative to evlog without redaction |
| ---: | --- | ---: | ---: |
| 5 | nuxt-wide-events | 2,089,948 | 2.71x |
| 5 | evlog 2.26.0, redaction disabled | 770,485 | baseline |
| 5 | evlog 2.26.0, runtime redaction enabled | 143,154 | 0.19x |
| 5 | pino 10.3.1, in-memory destination | 1,268,002 | 1.65x |
| 5 | raw object plus JSON.stringify | 2,314,866 | 3.00x |
| 20 | nuxt-wide-events | 465,242 | 1.71x |
| 20 | evlog 2.26.0, redaction disabled | 272,131 | baseline |
| 20 | evlog 2.26.0, runtime redaction enabled | 82,701 | 0.30x |
| 20 | pino 10.3.1, in-memory destination | 550,134 | 2.02x |
| 20 | raw object plus JSON.stringify | 1,110,360 | 4.08x |

## Runtime clocks and request ID

This case includes `crypto.randomUUID`, two `performance.now` calls, and ISO timestamp creation.

| Runtime | Operations/s | Relative to evlog |
| --- | ---: | ---: |
| nuxt-wide-events | 807,613 | 1.24x |
| evlog 2.26.0, redaction disabled | 653,709 | baseline |
| pino 10.3.1, in-memory destination | 611,344 | 0.94x |
| raw object plus JSON.stringify | 857,969 | 1.31x |
