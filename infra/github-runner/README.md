# Harlan's desktop GitHub runner

One host, one supervisor, one ephemeral container per job, across every private
Harlan site.

## Why pools and not one shared runner

GitHub scopes a self-hosted runner to a repository, an organization, or an
enterprise. There is no user-account scope, and nine of the ten sites belong to
the user `harlan-zw`, so each repository needs its own registration. The
supervisor holds every pool in one process so that is a config line, not a
service.

## Why nothing polls

Each container's runner listener holds a long poll against GitHub and prints
`Running job:` on stdout the instant it claims one. The supervisor reads that
line and treats it as the scale-up event. The only GitHub API call it makes is
one registration token per container, so a wide matrix costs no extra requests
and no webhook endpoint is needed.

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

Two labels serve every repository, so a workflow's `runs-on` is the same string
everywhere and a site moves between hosted and self-hosted by changing one input.

| Label | Use |
| --- | --- |
| `harlan-desktop-ci` | Lint, typecheck, test, build. No production secret. |
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

Stop local CI before shutting down or doing CPU-heavy local work:

```bash
systemctl --user stop harlan-desktop-github-runner.service
```

Queued jobs wait up to 24 hours for a matching online runner, so starting the
service drains the queue.

## Tuning

`runners.conf` carries `warm`, `max`, and `cpus` per pool. Environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HARLAN_DESKTOP_RUNNER_CPU_BUDGET` | `32` | Threshold above which bursts are held. Not a cap; see below. |
| `HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB` | `36` | Gibibytes of container memory limit in-flight work may hold. Leave the rest for the workstation. |
| `HARLAN_DESKTOP_RUNNER_BURST_IDLE_SECONDS` | `300` | Time a burst container may sit unclaimed before it is retired. |
| `HARLAN_DESKTOP_RUNNER_IMAGE` | `harlan-desktop-github-runner:2.336.0` | Image tag. |
| `HARLAN_DESKTOP_RUNNER_CONFIG` | `/etc/harlan-desktop-github-runner/runners.conf` | Pool table. |

Idle warm containers cost about 60 MB each and no CPU, so they do not spend
against the threshold. Only a warm container holding a job, and a burst container
from the moment it launches, do.

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

So bursts now spend a memory budget as well as a CPU one, and both must clear.
A pool that fits the CPU threshold but not the memory budget is held.

**The budget gates bursts, not warm slots.** A warm slot claims a job without
asking, so the sum of `warm * memory` across pools is capacity this host has
promised unconditionally, and no admission decision can take it back. The
supervisor logs that floor at startup when it exceeds the budget. Lowering
`warm` on the wider pools is the only lever for that half.

`CPU_BUDGET` holds back **bursts**; it cannot cap total load. A warm container
claims its job straight from GitHub and the supervisor has no say in it, so the
real floor is `sum(warm * cpus)` across every pool, and in-flight CPU exceeds the
threshold whenever enough warm runners are busy at once. That is intended: under
a wide multi-repository push, warm capacity absorbs the work and the rest queues
for a few seconds rather than piling burst containers onto a 24 core box.

The catch is that when the warm floor is at or above the threshold, bursting is
effectively off. The supervisor warns at startup when that is true, since the
symptom otherwise is every wide matrix serialising for no visible reason.

## Updating the runner

Update `RUNNER_VERSION` and `RUNNER_SHA256` in the Dockerfile, update the tag in
`HARLAN_DESKTOP_RUNNER_IMAGE` or the supervisor default, rebuild, then restart the
service. GitHub requires a runner update within 30 days of a release.
