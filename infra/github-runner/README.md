# Harlan's desktop GitHub runner

One host, one supervisor, one ephemeral container per job, across every private
Harlan site.

## Why pools and not one shared runner

GitHub scopes a self-hosted runner to a repository, an organization, or an
enterprise. There is no user-account scope, and nine of the ten sites belong to
the user `harlan-zw`, so each repository needs its own registration. The
supervisor holds every pool in one process so that is a config line, not a
service.

## Demand

The supervisor polls queued GitHub Actions jobs by runner label.

It reserves host capacity before it registers a runner.

Workflow shells with no jobs create no demand.

A warm listener remains optional for a pool that needs lower startup latency.

## Trust boundary

- Every pool is repository-scoped and accepts jobs from that repository only.
- Every job gets a newly registered ephemeral runner in a fresh container.
- Containers run unprivileged, drop all Linux capabilities, and receive no host
  filesystem mount and no Docker socket.
- Registration tokens enter through stdin, never through a file or an
  environment variable.
- **Public repositories are excluded on purpose.** A self-hosted runner on a
  public repository lets a fork pull request run code on this workstation.
  `unhead.unjs.io`, `request-indexing`, `harlanzw.com`, and `unlighthouse.dev`
  stay on GitHub-hosted runners. Before adding any of them, set "Require
  approval for all outside collaborators" on that repository.

## Labels

Resource labels serve every repository, so a workflow's `runs-on` is the same
string everywhere and a site moves between hosts by changing one input.

| Label | Use |
| --- | --- |
| `harlan-desktop-ci` | Lint, typecheck, test, build. No production secret. |
| `harlan-desktop-light` | Detection, reports, and API calls. Two CPUs and 2 GB by default. |
| `harlan-desktop-deploy` | Production deploys. Larger container, one at a time. |

Write them as `runs-on: [self-hosted, linux, x64, harlan-desktop-ci]`. The runner adds
`self-hosted`, `linux`, and `x64` itself.

## Host setup

Needs Docker, GitHub CLI authenticated with repository administration access on
every repository in `runners.conf`.

```bash
docker build --tag harlan-desktop-github-runner:2.336.0 infra/github-runner

install -Dm755 infra/github-runner/supervisor \
  ~/.local/lib/harlan-desktop-github-runner/supervisor
install -Dm755 infra/github-runner/publish-status \
  ~/.local/lib/harlan-desktop-github-runner/publish-status
install -Dm644 infra/github-runner/runners.conf \
  ~/.config/harlan-desktop-github-runner/runners.conf
install -Dm644 infra/github-runner/harlan-desktop-github-runner.service \
  ~/.config/systemd/user/harlan-desktop-github-runner.service

systemctl --user daemon-reload
systemctl --user enable --now harlan-desktop-github-runner.service
```

## Status

```bash
harlan-desktop-runner          # both sections
harlan-desktop-runner pool     # the workstation only, no network calls
harlan-desktop-runner sites    # open pull requests and their checks
```

`pool` reads the supervisor's own reservation files under `XDG_RUNTIME_DIR`, the
same ones it sizes bursts from, so it reports what the supervisor believes rather
than a second guess from `docker ps`. That is also why the unit does not put its
state in `/tmp`: `PrivateTmp` would hide it from this command.

`sites` lists every open pull request across the inventory with its check state,
then up to three recent local branches per repository that have commits and no
pull request. That last part is capped on purpose, since nuxtseo.com alone keeps
over a hundred branches. Raise `HARLAN_DESKTOP_RUNNER_BRANCH_LIMIT` for the long
tail.

Check capacity and logs:

```bash
docker ps --filter label=com.harlanzw.desktop-runner=true \
  --format '{{.Names}}\t{{.Label "com.harlanzw.desktop-runner.repository"}}'

gh api repos/harlan-zw/nuxtseo.com/actions/runners \
  --jq '.runners[] | [.name, .status, .busy] | @tsv'

journalctl --user --unit harlan-desktop-github-runner.service --follow
```

The supervisor publishes `status.json` beside its runtime state every 15 seconds.

The snapshot contains pool demand, active jobs, recent outcomes, and container resources. It contains no credentials or Docker configuration.

Stop local CI before shutting down or doing CPU-heavy local work:

```bash
systemctl --user stop harlan-desktop-github-runner.service
```

Stopping and restarting both drain. Idle listeners go immediately, so nothing
new is claimed, and the containers holding a job are left to finish. On a busy
host the command can therefore sit for minutes. Follow the journal to watch it:
the supervisor logs `Draining: N job(s) still running` every ten seconds.

Past `HARLAN_DESKTOP_RUNNER_DRAIN_TIMEOUT_SECONDS` the remaining jobs are killed,
and GitHub reports those as `the self-hosted runner lost communication with the
server`. Raise the variable above the longest job timeout in any consuming
workflow, and keep the unit's `TimeoutStopSec` above it.

Queued jobs wait up to 24 hours for a matching online runner, so starting the
service drains the queue.

## Tuning

`runners.conf` carries `warm`, `max`, and `cpus` per pool. Use zero warm runners
to make every job pass admission before runner registration.

Environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HARLAN_DESKTOP_RUNNER_CPU_BUDGET` | `32` | Threshold above which bursts are held. Not a cap; see below. |
| `HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB` | `36` | Gibibytes of container memory limit in-flight work may hold. Leave the rest for the workstation. |
| `HARLAN_DESKTOP_RUNNER_BURST_IDLE_SECONDS` | `300` | Time a burst container may sit unclaimed before it is retired. |
| `HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS` | `30` | Time between queued job demand checks. |
| `HARLAN_DESKTOP_RUNNER_STATUS_INTERVAL_SECONDS` | `15` | Time between read-only status snapshots. |
| `HARLAN_DESKTOP_RUNNER_DRAIN_TIMEOUT_SECONDS` | `1800` | Time a stop waits for jobs in flight before it kills them. Keep the unit's `TimeoutStopSec` above it. |
| `HARLAN_DESKTOP_RUNNER_IMAGE` | `harlan-desktop-github-runner:2.336.0` | Image tag. |
| `HARLAN_DESKTOP_RUNNER_CONFIG` | `/etc/harlan-desktop-github-runner/runners.conf` | Pool table. |

Idle warm containers cost about 60 MB each and no CPU.

Their possible jobs still count toward the startup floor.

## Why memory is budgeted separately

CPU oversubscribes safely. A container over its quota is throttled and its job
takes longer. Memory does not behave that way, and the difference has already
cost a production deploy.

`--memory` is a limit, not a reservation. Docker admits containers whose limits
sum well past physical RAM, and nothing reserves anything. On this host that
reached 164g of limits committed against 60g of RAM. The kernel resolves the
overcommit by killing the largest resident process, which is always a build, so
the symptom is a deploy dying at `nuxt build` with exit 129 while comfortably
inside its own 32g limit. It was not killed for exceeding its cap. It was the
biggest thing alive when the CI containers admitted beside it ran the host out.

Every demand-started runner spends CPU and memory before registration.

A runner starts only when both reservations fit.

Warm jobs can claim before admission.

The supervisor therefore rejects startup when the warm floor exceeds a budget.

It also rejects a memory budget larger than host RAM.

The supplied configurations use zero warm runners.

Queued jobs then wait for the next demand poll instead of bypassing admission.

## Hogwild installation

Install the versioned Hogwild files into their fixed system paths:

```bash
sudo install -Dm755 infra/github-runner/supervisor /var/lib/github-runner/bin/supervisor
sudo install -Dm755 infra/github-runner/publish-status /var/lib/github-runner/bin/publish-status
sudo install -Dm644 infra/github-runner/hogwild-runners.conf /var/lib/github-runner/config/runners.conf
sudo install -Dm644 infra/github-runner/hogwild-github-runner.service /etc/systemd/system/hogwild-github-runner.service
sudo install -Dm644 infra/github-runner/hogwild-logind.conf /etc/systemd/logind.conf.d/runner-safe-power.conf
sudo install -Dm755 infra/github-runner/hogwild-safe-poweroff /usr/local/sbin/hogwild-safe-poweroff
sudo systemctl daemon-reload
sudo systemctl kill --signal HUP systemd-logind
sudo systemctl restart hogwild-github-runner.service
```

Use `sudo hogwild-safe-poweroff` for a drained shutdown.

## Updating the runner

Update `RUNNER_VERSION` and `RUNNER_SHA256` in the Dockerfile, update the tag in
`HARLAN_DESKTOP_RUNNER_IMAGE` or the supervisor default, rebuild, then restart the
service. GitHub requires a runner update within 30 days of a release.
