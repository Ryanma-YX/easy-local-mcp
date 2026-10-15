# Linux: supervised Easy Local MCP Agent

A user-level systemd service is the recommended Linux installation. It
supervises the **Agent and everything it launches** as one cgroup, instead of
depending on each subprocess to execute JavaScript shutdown handlers.

## Requirements

- Linux with a working `systemd --user` manager and Node.js 22+.
- A built Easy Local MCP checkout (`npm ci && npm run build`).
- A configured, registered Agent. Its credentials stay in the user's
  `~/.localmcp` directory; do **not** put credentials in the unit file.
- For external MCP execution, V8 currently also requires `setsid`
  (util-linux). Direct execution still uses V8's application-level cleanup.

The user service runs with the **current user's permissions**, not as root.
Never run a personal Agent as root to solve a process-cleanup problem.

## Preview and install (opt in)

From the installed project directory:

```sh
npm run build
npm run service:user:preview
node scripts/systemd-user-service.mjs install
```

The installer uses absolute paths to the running Node binary and this checkout,
rejects an unrecognized existing `easy-local-mcp-1591e5a7.service`, and only writes
`~/.config/systemd/user/easy-local-mcp-1591e5a7.service` and reloads user units.
It **does not enable or start** the Agent automatically.

The user service has the **permanent project-specific name**,
`easy-local-mcp-1591e5a7.service`. Its eight-character hexadecimal
suffix was generated once using a cryptographically secure random source
and committed to the project; it is not regenerated per installation.
This greatly reduces accidental filename collisions, but does not make
deliberately redirected filesystem symlinks safe.

**Older experimental installations:** If you previously installed the
untagged `easy-local-mcp.service` user unit, stop and uninstall that
earlier unit using the previous version's installer before installing the
tagged version. V13 refuses installation and standalone launches while the
old unit-file path exists, rather than silently creating competing Agents.
It never automatically stops, migrates, or removes an older unit.


**Once installed**, normal `easy-local-mcp start|stop` commands and Control
Center's Start, Stop, and Restart actions route through this systemd user unit.
Direct `node dist/index.js agent` launches are refused instead of silently
creating an unsupervised Agent. To return to standalone mode, first uninstall
the managed unit. `easy-local-mcp status` and the Control Center display
the service mode and whether the running Agent matches systemd ownership.

If the unit is installed but not yet enabled, a normal Start action starts
the unit for the current session; this does not automatically enable startup
after login or reboot.

Before **installing** the service for the first time, stop any manually started
Agent using its normal CLI control command. The installer checks the local Agent
control endpoint and refuses first-time installation while a standalone Agent
is running. It also refuses an unexpected non-socket entry at the control
endpoint (for example, a file, directory, or symlink), without changing it.
The first-install preflight and unit-file write now hold the SAME
kernel-released startup mutex used by the Agent's control socket. The Agent
also rechecks managed-unit ownership under that mutex before it accepts
requests. Thus a concurrent install either detects an already-started
standalone Agent and refuses, or commits its unit before the Agent's final
check, causing that standalone startup to refuse. Managed-service updates
remain possible while its service is active. Do not manually kill unrelated
processes.

```sh
systemctl --user enable --now easy-local-mcp-1591e5a7.service
systemctl --user status easy-local-mcp-1591e5a7.service
journalctl --user -u easy-local-mcp-1591e5a7.service -n 80 --no-pager
```

Use `systemctl --user stop|start|restart easy-local-mcp-1591e5a7.service` to control
the installed service, or use the CLI/Control Center's normal lifecycle
buttons. A deliberate stop exits normally and is not automatically restarted;
a deliberate start invokes the user unit, never a detached fallback.

To remove the **installer-owned** service:

```sh
node scripts/systemd-user-service.mjs uninstall
```

The uninstall command disables and stops that unit and removes its owned
configuration. No other user service is affected.

## External MCP executables and PATH

The generated unit has an explicit executable `PATH`. It always includes the
directory containing the chosen Node.js binary, the absolute directories from
the installation command's `PATH`, and standard system directories. This
keeps `node` and `npx` available to external MCP servers when Node is
installed through a user-local version manager.

For other executable locations such as `uvx` or custom interpreters, use
the optional **install-time** path override:

```sh
LOCALMCP_SYSTEMD_PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH" \
  node scripts/systemd-user-service.mjs install
systemctl --user restart easy-local-mcp-1591e5a7.service
```

Only absolute `PATH` entries are accepted. This is **not** a login-shell
environment: if Node or an external tool is moved/updated to a different path,
run the installer again from the intended installation and restart the unit.
The override affects executable lookup, not MCP authorization. Commands with
explicit `env` settings may also need their own `PATH` configured.

## Login, reboot and privileges

Without lingering, the user's systemd manager is generally available while
that user has an active login session. To permit running after logout and
starting at boot, an administrator may enable lingering:

```sh
loginctl show-user "$USER" -p Linger
loginctl enable-linger "$USER"
```

The last command may require polkit authorization or administrator privileges.
On a machine where root/sudo access is available, **prefer a dedicated
unprivileged account** with its own user service and explicitly configured
lingering over running the Agent itself as root.

A system-wide service is another option, but must specify a dedicated
`User=`, `HOME`, and credentials location. This installer intentionally
manages only rootless user units. Do not install both a user unit and a
system-wide unit for the same Agent identity.

## Supervision contract

The installed unit uses these guarantees:

- `Type=notify`: the Agent announces readiness only after a local HTTP
  health probe succeeds. Relay connectivity can be temporarily unavailable.
- `WatchdogSec=25s`: the Agent periodically probes its local HTTP child and
  sends watchdog notifications **only when that probe succeeds**. A frozen
  Agent sends no heartbeat; systemd terminates its service.
- `KillMode=control-group`: all processes remaining in the service cgroup
  are terminated at service stop/restart, even if wrappers have exited or
  descendants created new Unix process groups/sessions.
- `Restart=on-failure` with a restart delay and start limits: failed Agents
  restart, but an endless crash loop eventually leaves the unit failed for
  investigation rather than spawning indefinitely.
- An installer-owned user unit is the sole owner of normal lifecycle actions.
  CLI, Control Center and desktop auto-start do not launch detached Agents
  once the service is installed. Status reports whether an existing Agent
  matches the systemd main PID. A conflicting standalone Agent fails closed.

If the Agent observes two consecutive failed HTTP health probes, it initiates
a failed shutdown. The systemd watchdog separately covers a frozen Agent
event loop. systemd cgroup cleanup applies before the restarted service is
considered running.

**Do not use process-count heuristics to kill unknown PIDs.** When a process
cannot be terminated (for example, uninterruptible kernel sleep), investigate
the failed unit rather than blindly launching another instance.

## Limitations

Systemd handles process cleanup for **the supervised unit**, not arbitrary
processes launched separately by hand or moved into another cgroup. Without
systemd, V8's application-level cleanup still applies, including its known
fast-exiting external-MCP launcher ownership race. A cgroup also does not
tell whether an interrupted file operation committed; never automatically
replay commands with side effects merely because the Agent restarted.

The user service has been tested with disposable transient units on Ubuntu,
including Agent `SIGKILL`, frozen Agent/HTTP processes, descendants in separate
Unix sessions, duplicate manual launches, and crash-loop throttling.
Persistence through an actual reboot, native macOS/Windows service handling,
and a privileged system-wide installation have **not** been validated.
