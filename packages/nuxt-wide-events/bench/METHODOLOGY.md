# Benchmark methodology

These benchmarks cover the production path. They exclude development formatting.

## Compared work

The main matrix creates one Wide Event with fixed request metadata.
It tests 0, 1, 5, and 20 primitive fields before JSON serialization.
The suite also measures runtime clocks, errors, field collection, and a 100 event burst.

- `nuxt-wide-events` receives fixed request ID, start time, end time, and timestamp values.
- `evlog@2.26.0` uses silent production mode. Its public API does not accept clocks or request timing.
- Evlog runs with runtime redaction enabled and disabled. The disabled result shows its fastest public path.
- `pino@10.3.1` serializes an equivalent record into an in-memory destination.
- The raw baseline allocates an equivalent record and calls `JSON.stringify`.

Evlog always adds `environment` and formatted `duration` fields. The comparison retains them because its public production API adds them.
Evlog also retains error messages and stacks. The other production error cases retain only the error status.

The fixed matrix removes clock and request ID noise.
The runtime case measures `crypto.randomUUID`, both `performance.now` calls, and ISO timestamp creation.

## Controls

Each task warms for at least 500 milliseconds and 1,000 iterations.
Each measured task runs for two seconds.
No task writes to a console, terminal, file, or network destination.

Run the suite on an idle machine with the same Node version.
Run it at least five times. Use the median run when comparing ratios.
Record the CPU, Node version, operating system, and commit SHA with published results.

```sh
pnpm --filter @harlan-zw/nuxt-wide-events test:bench
```

## Nitro HTTP load test

The HTTP test builds three identical Nuxt fixtures.
One enables this module with console output and drains disabled.
One enables evlog 2.26.0 with silent output and production defaults.
The baseline does not load either module.

The runner uses autocannon 8.0.0 with pipelining disabled.
It tests concurrency 1, 32, and 128 for 20 seconds each.
Each target warms for three seconds before each measured run.
Target order alternates across three repetitions.
The result also records total Nitro server JavaScript size before and after gzip.

```sh
node bench/http/run.mjs
```

## Pull request report

Pull requests build the base and proposed revisions on one ARM runner.
The CPU harness imports both built runtime files into one process and alternates their sample order.
It reports main thread CPU time with a paired 95% relative margin of error.
A CPU change appears after `max(5%, 2 × paired RME)`.

The allocation run disables V8 optimization and pins its semi-space.
It reports bytes allocated per request and surfaces changes above 2% and 32 bytes.
The bundle rows compare the enabled and disabled Nitro fixtures.
Gzip changes below 16 bytes stay inside the noise gate.

The measurement workflow has read-only repository access.
A separate trusted workflow validates the report artifact before updating one sticky pull request comment.
