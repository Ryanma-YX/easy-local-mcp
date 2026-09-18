# SECURITY-HARDENING-V1

## Status

Implementation complete on branch:

```text
security-hardening-v1
```

Do not merge automatically into `main`.

## Architecture preserved

The hardening keeps the existing architecture:

```text
ChatGPT / MCP client
  -> Cloudflare Worker relay
  -> authenticated WebSocket
  -> local Agent
  -> authenticated loopback HTTP MCP server
  -> files / shell / persistent processes / external MCP servers
```

The project was not rewritten. Existing workspace handling, loopback MCP transport, relay framing, hot reload, and lifecycle concepts remain in place.

## Trust boundaries

1. Remote MCP input is untrusted.
2. The Cloudflare Worker relay is trusted infrastructure and can observe relayed MCP plaintext after TLS termination.
3. The Agent-to-loopback HTTP hop is local-only and authenticated with an ephemeral token.
4. Workspace filesystem boundaries protect file tools only.
5. Shell and external MCP servers run with the Easy Local MCP process user's OS authority.
6. The local control IPC endpoint is the privileged management plane and is not exposed as an MCP tool.
7. External MCP descriptions/annotations are metadata only and are never trusted as an authorization boundary.

The architecture does not claim end-to-end encryption between ChatGPT and the local Agent.

## Baseline before changes

Executed on Windows before implementation:

- `npm ci`: PASS
  - npm reported 3 high severity dependency vulnerabilities
  - npm reported 3 install scripts not covered by allowScripts
- `npm run check`: PASS
- `npm test`: FAIL, 8 pass / 9 fail
  - several tests depended on missing `dist/index.js`
  - Windows symlink creation failed with EPERM
  - a `printf` shell test was not Windows portable
  - persistent-process cleanup hit EBUSY
- `npm run build`: PASS

These were recorded as pre-existing baseline conditions.

## Confirmed risks from the original code

- Fresh config defaulted `files`, `shell`, and `processes` to enabled.
- Example/default usage could expose the user's home directory.
- `features.files` was too coarse.
- Dangerous tools were immediately callable when configured.
- Tool discovery advertised dangerous tools without a local privilege gate.
- Workspace path validation did not sandbox shell commands.
- `localmcp status` printed the complete credential-bearing MCP URL.
- Sensitive state relied primarily on POSIX-style mode flags.
- Windows named-pipe control used a deterministic endpoint without an application-level secret.
- Public relay trust / plaintext relay semantics were not documented clearly.
- `POST /register` was open with no optional self-host registration secret.
- No structured local security audit log existed.
- `start:quick` maintained a second lifecycle/security path.
- Windows persistent-process state could remain incorrectly `running` because state was updated on `close` rather than `exit`, while descendants could retain inherited stdio handles.

## Implemented design

### Secure defaults

Fresh initialization now:

- uses the initialization directory as the explicit workspace
- uses `~/.localmcp/workspace` when initialization begins from the user's home directory
- enables file read only
- disables file write
- disables delete/move
- disables shell
- disables persistent processes
- disables external MCP execution

### Capability model

Filesystem permissions are separated into:

```text
files.read
files.write
files.delete
```

Additional capabilities:

```text
shell
processes
externalMcp
```

Legacy `features.files: true` remains migration-compatible and maps to read/write/delete configured.

### Local privilege gate

Agent startup state is always:

```text
LOCKED
```

CLI:

```text
localmcp unlock
localmcp unlock --minutes 30
localmcp lock
localmcp status
localmcp url
localmcp rotate
```

Unlock:

- is initiated only through local control IPC
- expires automatically
- resets after Agent restart
- can be revoked immediately
- is never exposed as an MCP tool

### Central authorization

`src/security.ts` centralizes:

- configured capability checks
- privileged-tool classification
- unlock checks
- audit helpers
- protected state writes
- local control secret handling

Tool discovery filters unavailable tools and every actual invocation performs server-side authorization again.

### Shell boundary

Workspace paths are explicitly documented as filesystem-tool boundaries, not shell sandboxes.

Shell remains:

```text
explicit configuration opt-in
+
local unlock
```

No unreliable cross-platform shell sandbox was added.

### External MCP

External MCP servers are now lazy-started.

Merely configuring or listing server names does not execute the server.

Starting/discovering tools and calling external tools require the privileged authorization path.

External MCP annotations are not trusted for authorization.

### Credential handling

- `localmcp status` masks MCP credentials.
- `localmcp url` explicitly reveals the full URL.
- security audit records omit URLs/tokens/secrets/payloads.
- sensitive state writes request restrictive modes.
- Windows additionally receives best-effort `icacls` hardening.
- device-mode `localmcp rotate` replaces Agent and MCP hashes in the Durable Object and disconnects existing Agent WebSockets.

Legacy single-user Worker rotation limitations are reported rather than hidden.

### Control IPC

Local control requests now carry a random application-level control secret stored under:

```text
~/.localmcp/control.secret
```

Authenticated control commands include:

- status
- stop
- reload
- unlock
- lock
- rotate

Remote MCP tools cannot invoke these lifecycle/security controls.

### Worker registration

Self-hosted deployments can set:

```text
REGISTRATION_TOKEN_HASH
```

The Agent sends the raw registration token through:

```text
Authorization: Bearer ...
```

using `LOCALMCP_REGISTRATION_TOKEN`.

Registration secrets are not placed in URLs.

Open registration remains available when the protection is intentionally not configured.

### Structured audit

Security audit:

```text
~/.localmcp/audit.log
```

Records security-relevant events while excluding:

- MCP tokens
- Agent tokens
- control secrets
- complete MCP URLs
- file contents
- stdout/stderr
- raw shell commands
- arbitrary secret-bearing payloads

Audit failure does not crash normal operation.

### Legacy lifecycle

`src/launch.ts` was removed.

`start:quick` now routes to the normal Easy Local MCP lifecycle instead of maintaining a separate project-local `.localmcp` / Quick Tunnel model.

### Windows ProcessManager fix discovered during validation

During full regression testing, the test runner exposed a real Windows lifecycle problem:

- tracked shell PID could already be gone
- descendants retained inherited stdio handles
- Node `close` was delayed
- Easy Local MCP continued to report the process as `running`
- temp directory cleanup could fail with EBUSY

Fix:

- update tracked state on `exit`
- maintain explicit `running` state
- terminate the Windows process tree with `taskkill /T /F`
- wait for process exit during ProcessManager shutdown

The previously failing hot-reload/persistent-process test now passes.

## Implementation checklist

- [x] granular secure config model and migration
- [x] safe first-run initialization
- [x] policy / unlock state component
- [x] tool discovery filtering
- [x] server-side privileged authorization
- [x] CLI lock/unlock/status/url/rotate
- [x] control IPC authentication
- [x] credential masking and protected state writes
- [x] structured security audit log
- [x] optional Worker registration secret
- [x] public relay trust warning/documentation
- [x] remove/unify legacy `start:quick`
- [x] regression tests
- [x] Windows/Linux/macOS CI matrix configured for normal test suite
- [x] `SECURITY.md`
- [x] README security updates
- [x] Phase 2 `LOCAL-CONTROL-UI.md`

Dependabot and CodeQL were considered but intentionally deferred to avoid expanding the scope of Security Hardening V1. They can be added independently.

## Regression coverage

Current tests cover:

- fresh install secure defaults
- no whole-home default exposure
- shell unavailable by default
- dangerous tools unavailable while locked
- unlock enabling only configured capabilities
- unlock expiry / lock state lifecycle
- immediate lock revocation
- Agent restart returns to LOCKED
- status masks MCP token
- explicit URL reveal
- local control authentication
- workspace traversal / symlink / hardlink protections
- HTTP token / Origin protection
- Worker Agent/MCP authentication
- registration protection when configured
- Worker credential rotation
- legacy explicit configuration migration
- external MCP lazy start and privileged invocation
- hot reload with in-flight calls/processes
- cross-platform command behavior
- Windows process cleanup behavior

## Local validation result

After implementation and the Windows process fix:

```text
npm run check   PASS
npm test        PASS
```

Full Windows test result:

```text
tests 19
pass  19
fail  0
```

Final pre-commit validation completed:\n\n```text\nnpm run check   PASS\nnpm test        PASS (19/19)\nnpm run build   PASS\nnpm audit       PASS (0 vulnerabilities)\n```

The GitHub Actions workflow is configured for:

```text
ubuntu-latest
macos-latest
windows-latest
```

with Node:

```text
22
24
```

and runs the normal test suite. Remote matrix results require the branch to be pushed and GitHub Actions to execute.

## Backward compatibility

Existing explicit configuration is not silently rewritten.

Legacy fields remain accepted.

Fresh generated configuration uses secure granular capabilities.

Intentional compatibility changes:

- privileged operations now require local unlock
- `status` no longer reveals the full MCP URL
- callers use `localmcp url` when explicit credential reveal is required
- `start:quick` uses the normal lifecycle
- external MCP processes are lazy rather than eagerly started

## Remaining risks / Phase 2

Remaining risks are explicit:

- shell still runs with OS-user authority
- external MCP servers still run with OS-user authority
- public/self-host Worker remains trusted relay infrastructure
- no end-to-end encryption exists between ChatGPT and local Agent
- Windows ACL hardening is best effort
- a malicious process already running as the same OS user is outside the lock gate's protection goal
- install-script approval warnings remain for `esbuild` / `workerd`; review `allowScripts` separately before enabling third-party install scripts

Future UI design:

```text
docs/tasks/LOCAL-CONTROL-UI.md
```

The future tray/control panel must call the same local policy/control layer and must not create a second authorization model.
