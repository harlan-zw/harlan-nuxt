# Hogwild host

Hogwild runs the GitHub runner supervisor, the Harlan GitHub Agent, the status
site, AdGuard DNS, Jellyfin, and a Cloudflare tunnel. This file records the
host security layout after the security pass on 2026-09-11. The runner has its
own file in `infra/github-runner`.

## Accounts

| Account | Purpose | sudo | docker |
| --- | --- | --- | --- |
| `harlan` | Runs the Harlan GitHub Agent as a `systemctl --user` unit. Owns `~/pkg`, `~/sites`, the Agent state, and its tools in `~/.local/bin`. | none | none |
| `harlan-admin` | Host administration only. | `NOPASSWD: ALL` | yes |
| `hogwild-deploy` | Receives status site releases over a forced SSH command. | one script | none |
| `github-runner` | Runner supervisor service. Holds the Docker socket by design. | none | yes |

The Agent runs `opencode run --auto` on public issue text. The account it runs
as must never hold root or the Docker socket. Before 2026-09-11 `harlan` held
both. `harlan-admin` now holds them and `harlan` holds neither.

From the desktop:

```bash
ssh hogwild          # harlan: the Agent account. Desktop scripts use it. No sudo.
ssh hogwild-admin    # harlan-admin: sudo and docker.
```

Both hosts use the same key. The desktop Agent scripts in `harlan-agent-kit`
keep `hogwild`, so nothing there changed.

If the Agent needs a package, install it as `harlan-admin`:

```bash
ssh hogwild-admin 'sudo apt-get install -y <package>'
```

If a tool needs a different name, link it into the Agent's path as `harlan`:

```bash
ssh hogwild 'ln -sf "$(command -v fdfind)" ~/.local/bin/fd'
```

If a future task needs containers, give `harlan` rootless Docker. Never add
`harlan` to the `docker` group.

## Docker network rules

Docker publishes ports past ufw. A test container with `-p 5433:5433` answered
from the LAN with no ufw rule. Containers could also reach the LAN router.

Two controls close this:

- `/etc/docker/daemon.json` sets `"ip": "127.0.0.1"`, so a published port binds
  loopback unless the container asks for an address. Docker reads it at its
  next restart.
- `hogwild-docker-user.service` fills the `DOCKER-USER` chain from
  `hogwild-docker-user-rules`. Containers cannot reach private networks, the
  tailnet, or link-local addresses. The LAN and the tailnet cannot open
  connections to published ports. The desktop DNS fallback and loopback still
  work. The ufw rules in `infra/github-runner/README.md` still cover DNS to the
  host itself, because that traffic is input, not forwarding.

Install:

```bash
sudo install -Dm755 infra/hogwild/hogwild-docker-user-rules /usr/local/sbin/hogwild-docker-user-rules
sudo install -Dm644 infra/hogwild/hogwild-docker-user.service /etc/systemd/system/hogwild-docker-user.service
sudo systemctl daemon-reload
sudo systemctl enable --now hogwild-docker-user.service
```

The unit is `PartOf=docker.service`, so a Docker restart reloads it. `ufw reload`
flushes every chain, including Docker's own. After a ufw reload, restart Docker.

Verify:

```bash
sudo iptables -S DOCKER-USER
docker run --rm alpine:3.20 sh -c 'nc -z -w2 192.168.50.1 80 && echo LAN-OPEN || echo LAN-closed'
```

## Audit

`auditd` watches sshd config, sudoers, unit files, the Docker daemon config,
Jellyfin, AdGuard, and both admin `authorized_keys` files. Rules live in
`/etc/audit/rules.d/hogwild.rules`. Lynis runs nightly.

## Pending

- The Agent's running process still carries the old groups. A `systemctl
  --user` restart does not refresh them; only the user manager does. The next
  host reboot completes the change. Drain the runner first:
  `sudo systemctl stop hogwild-github-runner.service`, then `sudo reboot`.
- The runner credential in `/etc/credstore.encrypted` is an OAuth token with
  `admin:org` and `admin:public_key`. Replace it with a fine-grained token that
  has Administration write on the repositories in `runners.conf` only.
- `agent.harlanzw.com` sits on the public internet behind HTTP Basic auth only.
  Put Cloudflare Access in front, or remove the Caddy route and use the tailnet
  URL.
- The tailnet holds a device from another account. Add a Tailscale ACL that
  limits it to Jellyfin.
- The desktop key `~/.ssh/id_ed25519_hogwild` has no passphrase.
- The Z.ai key in `~/.config/opencode/opencode.json` on Hogwild should be
  rotated and loaded from the environment.
- `harlan-zw/gscdump.com` stays in `runners.conf`. Remove it before that
  repository goes public.

## Accepted

- AdGuard's admin UI binds every interface on port 5380. ufw blocks it on the
  LAN. Binding it to the tailnet address would fail at boot if `tailscale0`
  comes up late, so it stays.
- The runner supervisor holds the Docker socket. Its containers drop every
  capability, run as a non-root user, and get no socket.
