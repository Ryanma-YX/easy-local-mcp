# LOCAL-CONTROL-UI

## Goal

Design a small future local control panel / tray application for LocalMCP.

This is a Phase 2 design only. The current security-hardening task must not introduce a large Electron application or a second authorization model.

The UI must be a thin local client over the same security, policy, lifecycle, and control mechanisms used by the CLI.

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

## Proposed architecture

```text
Tray / local control UI
        |
        | local authenticated IPC
        v
Local control service
        |
        +--> lifecycle
        +--> security policy / unlock state
        +--> configuration
        +--> credential rotation
        +--> audit reader
        |
        v
LocalMCP Agent
```

The control service is the authority. The UI is presentation only.

## Main surfaces

### 1. Connection status

Show:

- Agent running/stopped
- relay connected/disconnected
- current Worker origin
- device ID when available
- masked MCP URL
- configuration path
- Agent log path
- current LOCK / UNLOCK state
- unlock expiry

Do not show the full MCP credential by default.

Provide a deliberate **Reveal / Copy MCP URL** action with a warning that the URL is a credential.

### 2. Workspaces

Show configured workspaces:

- name
- path
- default workspace
- read permission
- write permission
- delete/move permission

Future workspace editing should validate paths through the same configuration layer used by the CLI.

The UI must not imply that a workspace path restricts shell access.

### 3. Permission profile

Present effective capabilities:

- files.read
- files.write
- files.delete
- shell
- persistent processes
- external MCP

Separate:

- **configured**
- **currently available**

For example, `shell` may be configured but unavailable because the Agent is LOCKED.

### 4. LOCK / UNLOCK

Primary security control:

- LOCK immediately
- UNLOCK for 5 / 15 / 30 / 60 minutes
- custom duration within policy limits
- visible countdown / expiry time

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

### 8. Worker selection

Allow the user to view or configure:

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

## Local IPC requirements

The UI must use the authenticated local control channel.

It must not:

- open a TCP admin port
- expose unlock as an MCP tool
- bypass the control secret
- read credential files directly when a control operation exists
- invent a separate unlock state

If richer status/config operations are needed, extend the local control protocol with narrowly scoped commands.

## Configuration editing

If the UI later edits `localmcp.json`:

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

## Suggested implementation phases

### Phase A — read-only tray

- status
- lock state
- masked URL
- workspaces
- effective capabilities
- audit viewer

### Phase B — local actions

- lock
- timed unlock
- explicit URL copy
- credential rotation
- controlled config editing

### Phase C — per-action approval

Only after a request/approval protocol is designed and threat-modeled.

## Acceptance criteria

A future UI implementation is acceptable only if:

- CLI and UI produce the same effective authorization decisions
- restarting the Agent resets unlock state
- UI compromise does not create a remote admin endpoint
- full credentials are hidden by default
- security audit remains redacted
- shell/workspace limitations are accurately described
- the core authorization layer remains UI-independent
