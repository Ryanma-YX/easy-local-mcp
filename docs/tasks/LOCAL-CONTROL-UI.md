# LOCAL-CONTROL-UI

## Status

Implemented on branch:

```text
local-control-ui-v1
```

The implementation is a lightweight local Web control UI started by `localmcp ui`. It uses native Node HTTP plus plain HTML/CSS/JavaScript; no Electron or frontend framework was introduced.

The UI is a thin local client over the same security, policy, lifecycle, and authenticated control IPC mechanisms used by the CLI.

## Goal

Provide a small local control panel for LocalMCP without introducing a remote administration surface or a second authorization model.

## Design principles

1. **One security model** — CLI and UI call the same local control/policy layer.
2. **Local only** — no remote web administration endpoint.
3. **Least privilege** — UI cannot bypass configuration or the LOCK / UNLOCK gate.
4. **Explicit dangerous actions** — unlock, credential reveal, rotation, and policy changes require visible user intent.
5. **No secret-rich logs** — the UI must not persist tokens, full MCP URLs, raw shell commands, or arbitrary tool payloads in its own logs.
6. **Small footprint** — prefer a lightweight local tray/control panel rather than Electron unless later requirements justify it.

## Existing core to reuse

The current implementation already provides the primitives the UI should consume:

- lifecycle state
- local authenticated control IPC
- LOCK / UNLOCK with expiry
- masked status
- explicit URL reveal
- credential rotation
- configuration file
- centralized tool authorization policy
- structured security audit log

The UI must not reimplement authorization decisions.

## Implemented architecture

```text
Browser
  -> http://127.0.0.1:<dynamic-port>
  -> ephemeral HttpOnly local UI session
  -> localmcp ui process
       +--> authenticated native control IPC -> LocalMCP Agent
       +--> existing config parser -> localmcp.json
       +--> atomic protected config writer
       +--> redacted audit reader
```

The Agent control IPC and existing security policy remain authoritative. The browser UI is presentation plus narrowly scoped local configuration management; it is not an MCP endpoint and does not implement a second unlock state.

## Main surfaces

### 1. Connection status

Current v1 shows:

- Agent running/stopped and readiness
- Agent PID when running
- current Worker origin
- masked MCP URL
- configuration path
- current LOCK / UNLOCK state
- unlock expiry

Relay-specific connection detail, device ID, and Agent log-path presentation can be added later if needed without changing the control boundary.

Do not show the full MCP credential by default.

Provide a deliberate **Reveal / Copy MCP URL** action with a warning that the URL is a credential.

### 2. Workspaces

Current v1 shows configured workspaces:

- name
- path
- default workspace

File read/write/delete permissions are shown in the global feature configuration because they are currently configuration-wide rather than per-workspace permissions.

Future workspace editing should validate paths through the same configuration layer used by the CLI.

The UI must not imply that a workspace path restricts shell access.

### 3. Permission profile

Current v1 presents configured capabilities:

- files.read
- files.write
- files.delete
- shell
- persistent processes
- external MCP

The separate LOCK / UNLOCK status remains visible, so a configured privileged capability is not implied to be callable while the Agent is locked. A richer per-capability effective-availability presentation can be added later.

### 4. LOCK / UNLOCK

Current v1 security controls:

- LOCK immediately
- UNLOCK for 5 / 30 / 60 minutes
- visible expiry time

Custom durations remain available through the CLI and can be added to the UI later.

On Agent restart the UI must show LOCKED even if it previously displayed UNLOCKED.

The UI must call the same local control command as `localmcp unlock` and `localmcp lock`.

### 5. Pending privileged action approval

Future optional feature.

If implemented, a remote privileged tool request could enter a short-lived local approval queue instead of simply failing while locked.

Possible UI:

```text
Pending action
Tool: run_command
Workspace: project
Requested: 14:32:08
Safe metadata: command hash / category only
[Approve once] [Unlock 5 min] [Deny]
```

Rules:

- raw command strings are not required for audit and may contain secrets
- approval must be tied to a specific request identity
- approval must expire
- replay must not be possible
- approval must not silently become a broad permanent permission

This feature requires a protocol design before implementation and is not part of Security Hardening V1.

### 6. Audit history

Read `~/.localmcp/audit.log` through a safe parser.

Show:

- timestamp
- event
- tool
- workspace
- result
- duration
- denial reason
- lock/unlock events
- rotation events

Do not attempt to reconstruct secret-bearing payloads.

Provide filtering and export only after a redaction review.

### 7. Credential rotation

Provide a deliberate **Rotate credentials** action.

Flow:

1. explain that current connections may be interrupted
2. require local confirmation
3. call the existing rotation control operation
4. show success/failure
5. refresh masked connection state

Do not claim complete rotation for legacy Worker modes that do not support device-scoped revocation.

### 8. Worker selection — future

The current UI shows the active Worker origin. A future version may allow the user to view or configure:

- default public relay
- custom/self-hosted Worker origin
- whether registration protection is expected

Warnings:

- public relay is trusted infrastructure
- current design is not end-to-end encrypted
- sensitive environments should prefer a controlled self-hosted Worker

Registration secrets must never be placed in URLs.

## Security warnings

The UI should prominently communicate:

> LocalMCP runs with your OS user permissions. Enabling Shell or arbitrary external MCP servers can grant capabilities equivalent to that OS user.

And:

> Workspace restrictions protect LocalMCP file tools. They do not sandbox Shell commands.

These warnings should be visible near permission controls rather than hidden only in documentation.

## Local control transport

The implemented browser UI uses a loopback-only HTTP listener as a presentation transport and continues to use the authenticated native control IPC as the privileged Agent control channel.

The HTTP listener:

- binds explicitly to `127.0.0.1`
- uses a dynamic port by default
- validates loopback peers, exact `Host`, and same-origin `Origin`
- rejects query strings on control API routes
- requires an ephemeral `HttpOnly`, `SameSite=Strict` browser session for API access
- never exposes `control.secret` to the browser

It must not expose unlock as an MCP tool, bypass the native control secret, read credential files directly when an existing control operation is available, or invent a separate unlock state.

## Configuration editing

The implemented UI edits the existing `localmcp.json` with these rules:

- validate against the same schema before replacing the file
- write atomically
- preserve unknown future-compatible values only if the schema explicitly permits them
- show validation errors without discarding the previous valid config
- do not silently broaden permissions
- require explicit confirmation when enabling shell, processes, external MCP, file write, or delete/move

## Packaging options

Evaluate lightweight options before Electron:

- native tray wrapper with a small embedded webview
- Tauri-style shell
- platform-specific tray launchers over a shared local web UI bound to loopback only, if the threat model supports it

Any option must preserve the same backend control/security layer.

## Non-goals

Phase 2 UI is not:

- a remote administration console
- a shell sandbox
- an MCP authorization replacement
- a cloud account system
- a secret manager
- a reason to weaken existing local authentication

## Implementation phases

### Phase A — local read surfaces — implemented

- status / readiness
- lock state and expiry
- masked URL / Worker origin
- workspaces
- configured capability view
- redacted audit viewer

### Phase B — local actions — implemented

- lock
- timed unlock (5 / 30 / 60 minutes)
- explicit URL reveal/copy
- credential rotation
- controlled config editing with atomic writes and reload

### Phase C — per-action approval — not implemented

Only after a request/approval protocol is designed and threat-modeled.

## Acceptance criteria

The implementation is acceptable only if:

- CLI and UI produce the same effective authorization decisions
- restarting the Agent resets unlock state
- UI compromise does not create a remote admin endpoint
- full credentials are hidden by default
- security audit remains redacted
- shell/workspace limitations are accurately described
- the core authorization layer remains UI-independent
