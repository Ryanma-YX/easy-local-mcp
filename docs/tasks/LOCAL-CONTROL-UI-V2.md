# LOCAL-CONTROL-UI-V2

## Status

Implemented on branch:

```text
local-control-ui-v2
```

V2 turns the original local Web control MVP into a fuller LocalMCP Control Center while preserving the same security model.

## Goals

- make Agent lifecycle manageable without returning to the CLI for routine operations
- make Workspace boundaries editable and validated
- distinguish configured capability from current callable availability
- expose safe Relay / Worker state and controlled device re-registration
- improve audit inspection without broadening logged data
- keep all browser control local-only and keep Agent IPC authoritative

## Implemented surfaces

### Dashboard

Shows:

- Agent running / connecting / stopped
- Relay connected / connecting / stopped
- LOCKED / UNLOCKED
- default Workspace

The page refreshes status periodically without exposing the control secret.

### Agent lifecycle

The UI can:

- Start
- Stop
- Restart
- Reload configuration
- Lock immediately
- Unlock for 5 / 30 / 60 minutes

Stop and Restart require explicit browser confirmation.

Lifecycle actions call the existing local lifecycle/control layer rather than implementing process management in browser code.

### Permissions

Each capability shows three distinct states:

- Configured
- Effective config
- Current availability

Current availability accounts for:

- capability disabled
- Agent stopped
- Agent connecting
- privileged capability blocked by LOCK
- available

Capabilities remain:

- files.read
- files.write
- files.delete
- shell
- processes
- externalMcp

The LocalMCP authorization layer remains authoritative.

### Workspace management

The UI supports:

- add Workspace
- edit Workspace name/path
- remove Workspace
- set default Workspace

Workspace changes:

- require explicit confirmation
- validate the full candidate configuration through the existing config parser
- require paths to resolve to existing directories
- atomically replace the config file
- preserve unrelated supported config sections
- reload a running Agent

Workspace names accepted by the UI are intentionally restricted to letters, digits, dot, underscore, and hyphen.

### Relay / Worker management

The UI shows:

- Relay connection state
- active Worker origin
- device ID
- masked MCP URL
- whether Worker origin is controlled by LOCALMCP_WORKER_URL

The UI can explicitly re-register the Agent with another validated Worker origin.

Security properties:

- re-registration is performed inside the Agent
- the browser sends only the Worker origin
- agentToken and mcpToken never enter browser responses
- LOCALMCP_REGISTRATION_TOKEN remains an environment-only input
- HTTPS is required except localhost / 127.0.0.1 development origins
- credentials are replaced through the existing protected worker state file
- changing Worker does not claim to revoke a previous Worker's remote device registration; revoke/rotate that old registration separately when required
- re-registration is audited without logging credential material
- if LOCALMCP_WORKER_URL is present, UI Worker editing is disabled

### Audit history

V2 keeps the existing safe-field projection and adds client-side filtering:

- all events
- denied / errors
- security / credentials
- configuration
- tool activity
- free-text filtering

Filtering does not add more source fields to the browser.

## Control protocol changes

The authenticated native control IPC now has a `reregister` command.

Its request contains:

```text
workerUrl
```

The Agent validates the origin, performs registration, securely replaces Worker credentials, updates its non-secret connection state, and reconnects.

Status now also exposes these non-secret fields to trusted local control clients:

- workerUrl
- deviceId
- workerManagedByEnv

The full MCP URL remains credential-bearing and is still masked outside explicit reveal.

## Security boundary

V2 does not change these properties:

- UI binds only to 127.0.0.1
- browser API is not an MCP endpoint
- browser session is short-lived, random, HttpOnly, SameSite=Strict
- exact Host, Origin, and loopback peer checks remain mandatory
- control.secret never enters browser content
- dangerous capability enablement requires confirmation
- Worker re-registration, credential rotation, URL reveal, Workspace boundary changes, Stop, and Restart require explicit local intent
- the Agent and authorization layer remain authoritative

## Desktop / tray direction

V2 deliberately keeps the presentation as the existing local Web UI.

A later desktop shell should wrap this control center rather than fork its backend or authorization logic. Preferred direction:

1. lightweight native tray
2. embedded system WebView / Tauri-style shell
3. reuse the same loopback UI and authenticated Agent IPC
4. no Electron unless platform requirements justify the footprint

A desktop wrapper must not add another credential store or remote administration listener.

## Not implemented in V2

### Per-action approval

A pending privileged request queue remains a separate future phase.

It needs a request identity, expiry, replay protection, and one-shot approval semantics before implementation.

### Native folder picker

The browser UI accepts Workspace paths as text. A future desktop shell can provide a native folder chooser while still sending the selected path through the same config validation path.

### Remote administration

Still intentionally out of scope.

## Validation

V2 must pass:

```text
git diff --check
npm run check
npm test
npm run build
npm audit --registry=https://registry.npmjs.org
```

The Control UI integration test uses isolated HOME / USERPROFILE state and covers:

- loopback-only UI session behavior
- credential redaction
- capability availability
- dangerous capability confirmation
- Workspace validation and atomic persistence
- Worker re-registration through control IPC
- audit redaction
- preservation of unrelated configuration
