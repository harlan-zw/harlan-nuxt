# GitHub Actions runners

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
| `harlan-ci` | Lint, typecheck, test, build. No production secret. |
| `harlan-deploy` | Production deploys. Larger container, one at a time. |

Write them as `runs-on: [self-hosted, linux, x64, harlan-ci]`. The runner adds
`self-hosted`, `linux`, and `x64` itself.

## Host setup

Needs Docker, GitHub CLI authenticated with repository administration access on
every repository in `runners.conf`.

```bash
docker build --tag harlan-actions-runner:2.336.0 infra/github-runner

install -Dm755 infra/github-runner/supervisor \
  ~/.local/lib/harlan-actions-runner/supervisor
install -Dm644 infra/github-runner/runners.conf \
  ~/.config/harlan-actions-runner/runners.conf
install -Dm644 infra/github-runner/harlan-actions-runner.service \
  ~/.config/systemd/user/harlan-actions-runner.service

systemctl --user daemon-reload
systemctl --user enable --now harlan-actions-runner.service
```

Check capacity and logs:

```bash
docker ps --filter label=com.harlan.github-runner=true \
  --format '{{.Names}}\t{{.Label "com.harlan.github-runner.repository"}}'

gh api repos/harlan-zw/nuxtseo.com/actions/runners \
  --jq '.runners[] | [.name, .status, .busy] | @tsv'

journalctl --user --unit harlan-actions-runner.service --follow
```

Stop local CI before shutting down or doing CPU-heavy local work:

```bash
systemctl --user stop harlan-actions-runner.service
```

Queued jobs wait up to 24 hours for a matching online runner, so starting the
service drains the queue.

## Tuning

`runners.conf` carries `warm`, `max`, and `cpus` per pool. Environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HARLAN_RUNNER_CPU_BUDGET` | `32` | Cores that in-flight jobs may hold at once, across all pools. |
| `HARLAN_RUNNER_BURST_IDLE_SECONDS` | `300` | Time a burst container may sit unclaimed before it is retired. |
| `HARLAN_RUNNER_IMAGE` | `harlan-actions-runner:2.336.0` | Image tag. |
| `HARLAN_RUNNER_CONFIG` | `/etc/harlan-actions-runner/runners.conf` | Pool table. |

Idle warm containers cost about 60 MB each and no CPU, so they do not spend the
budget. Only a warm container holding a job, and a burst container from the
moment it launches, do.

## Updating the runner

Update `RUNNER_VERSION` and `RUNNER_SHA256` in the Dockerfile, update the tag in
`HARLAN_RUNNER_IMAGE` or the supervisor default, rebuild, then restart the
service. GitHub requires a runner update within 30 days of a release.
