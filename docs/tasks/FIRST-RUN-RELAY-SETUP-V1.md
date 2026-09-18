# FIRST-RUN-RELAY-SETUP-V1

## Goal

Require an explicit Relay choice before a fresh Easy Local MCP Agent can start.

The public Relay remains the suggested default in the UI, but it is no longer an implicit runtime fallback.

## First-run behavior

Fresh state:

- Control Center starts locally.
- Agent remains stopped.
- Main dashboard is hidden behind the Relay setup step.
- Public Relay URL is prefilled.
- No registration request is sent until the user confirms.
- `Start Agent` is blocked until Relay configuration exists.

The primary first-run action is:

```text
Save & Start Agent
```

It:

1. validates the Relay origin;
2. optionally stores a registration token in a restrictive temporary state file;
3. persists the explicit Relay preference to `~/.localmcp/relay.json`;
4. starts the Agent;
5. registers the device;
6. persists the returned Worker credentials locally;
7. deletes the temporary registration token only after that local persistence succeeds.

## Existing-install compatibility

Existing users are not forced through the wizard when one of these already exists:

- `LOCALMCP_WORKER_URL`
- `~/.localmcp/relay.json`
- an existing `~/.localmcp/worker.json`

The legacy `worker.json` path is treated as an explicit previous Relay choice.

Malformed legacy worker credentials still fail inside Agent startup, preserving the previous `startup failed` lifecycle behavior instead of changing failure semantics.

## Relay changes after setup

When the Agent is stopped:

- Relay changes are saved for the next Agent start.

When the Agent is running:

- Relay changes perform explicit re-registration through authenticated control IPC.

Changing Relay does not revoke an old remote registration automatically.

## Registration token

A custom Relay may require a registration token.

UI-provided tokens:

- travel only over the authenticated loopback Control Center API;
- are stored at `~/.localmcp/registration-token.pending` with the existing restrictive state-file handling;
- are not returned to the browser;
- are not logged in audit;
- are not stored in `localmcp.json`;
- are deleted immediately after registration succeeds.

`LOCALMCP_REGISTRATION_TOKEN` remains supported and takes precedence as an environment-managed value.

## Enforcement

The rule is not UI-only.

The lifecycle start path checks for an explicit Relay configuration before spawning a fresh Agent. This means CLI and other local callers cannot bypass the first-run requirement and silently fall back to the public Relay.

## Validation

Automated coverage includes a fresh isolated Control Center state that verifies:

- Agent is stopped;
- Relay is unconfigured;
- public Relay appears only as `suggestedWorkerUrl`;
- direct Agent start is rejected;
- saving a custom Relay persists `relay.json`;
- optional registration token is written to the pending restricted state file;
- registration token is absent from audit output.

Full test suite after implementation:

```text
28 passed
0 failed
```
