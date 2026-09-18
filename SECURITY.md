# LocalMCP Security Model

LocalMCP is a **privileged local agent**. It runs with the permissions of the current operating-system user and can expose capabilities such as filesystem mutation, shell execution, persistent processes, and external MCP servers.

Enabling a capability is therefore equivalent to granting a remote MCP caller access to that capability under the current OS user's authority. Treat LocalMCP configuration, credentials, the local control channel, and the relay as security-sensitive infrastructure.

## Trust boundaries

The normal architecture is:

```text
ChatGPT / MCP client
  -> Cloudflare Worker relay
  -> authenticated WebSocket
  -> local Agent
  -> authenticated loopback HTTP MCP server
  -> local tools / external MCP servers
```

Security boundaries:

1. Remote MCP input is untrusted.
2. The Cloudflare Worker relay is trusted infrastructure.
3. The relay terminates TLS and can observe relayed MCP request/response plaintext.
4. The Agent-to-loopback HTTP hop is local-only and authenticated with an ephemeral token.
5. Filesystem workspace boundaries apply to filesystem tools only.
6. Shell commands and external MCP servers run with the LocalMCP process user's OS permissions.
7. The local control IPC endpoint is the privileged management plane and is not exposed as an MCP tool.

The current architecture does **not** provide end-to-end encryption between ChatGPT and the local Agent.

For sensitive development environments, prefer a self-hosted Worker whose operation and access controls you manage.

## Secure defaults

Fresh initialization uses the directory from which LocalMCP is initialized as the explicit workspace. If initialization is started from the user's home directory, LocalMCP creates a dedicated `~/.localmcp/workspace` instead of exposing the whole home directory.

Fresh configuration defaults to:

- filesystem read: enabled
- filesystem write: disabled
- filesystem delete/move: disabled
- shell: disabled
- persistent processes: disabled
- external MCP calls: disabled

Example:

```json
{
  "workspaces": {
    "project": "/path/to/project"
  },
  "defaultWorkspace": "project",
  "features": {
    "files": {
      "read": true,
      "write": false,
      "delete": false
    },
    "shell": false,
    "processes": false,
    "externalMcp": false
  }
}
```

### Legacy configuration migration

Existing explicit configurations remain accepted.

A legacy configuration such as:

```json
{
  "features": {
    "files": true,
    "shell": true,
    "processes": true
  }
}
```

continues to mean:

- file read/write/delete are configured
- shell is configured
- persistent processes are configured

However, configured dangerous capabilities still require the local unlock gate before they can be used.

Existing configured external MCP servers remain discoverable through the migration layer unless `features.externalMcp` is explicitly disabled.

## Local LOCK / UNLOCK gate

The Agent always starts **LOCKED**.

Privileged operations are unavailable while locked even if the configuration enables them.

Commands:

```sh
localmcp status
localmcp unlock
localmcp unlock --minutes 30
localmcp lock
localmcp url
localmcp rotate
```

Default unlock duration is 30 minutes. Unlock duration must be between 1 and 480 minutes.

Unlock state:

- can only be changed through the local control channel
- is never exposed as an MCP tool
- expires automatically
- resets to LOCKED after Agent restart
- can be revoked immediately with `localmcp lock`

Privileged capabilities include:

- `write_file`
- `edit_file`
- `apply_patch`
- `create_directory`
- `delete_path`
- `move_path`
- `run_command`
- persistent-process tools
- external MCP discovery/execution that starts or calls an external MCP server

Tool discovery hides unavailable tools, but server-side authorization is also enforced on every tool call. Clients must not rely on tool-list hiding as the security boundary.

## Filesystem boundaries are not shell sandboxes

The workspace boundary prevents filesystem tools from directly traversing outside configured workspace roots.

It does **not** sandbox shell commands.

For example, a command launched with a workspace directory as its `cwd` can still reference another drive, another directory, network resources, environment variables, or any other resource accessible to the current OS user.

Therefore shell execution is:

1. explicit opt-in in configuration, and
2. unavailable until the Agent is locally unlocked.

LocalMCP does not attempt to provide a cross-platform shell sandbox in this version.

## External MCP servers

External MCP servers are privileged.

They are started lazily only when an authorized operation needs them. Merely listing configured server names does not start them.

External MCP tool descriptions, schemas, and annotations are treated as untrusted metadata. They do not grant authority and are never used as the authorization boundary.

A configured external MCP server can execute with the same OS authority as the LocalMCP process. Review the server and its command line before enabling it.

## Credentials

Credential-bearing state is stored under `~/.localmcp/`.

Sensitive files include:

- `worker.json`
- `connection.json`
- `control.secret`
- transient unlock state

LocalMCP writes sensitive state with restrictive permissions where supported.

On POSIX systems, files are written with restrictive modes.

On Windows, LocalMCP additionally makes a best-effort attempt to restrict the file ACL with `icacls`. POSIX mode flags alone are **not** a Windows ACL security boundary. If ACL hardening cannot be applied, LocalMCP warns but continues running.

### MCP URL

The MCP URL contains a credential.

`localmcp status` masks the credential.

Use:

```sh
localmcp url
```

only when you intentionally need the complete URL for connection setup.

Do not place the complete URL in:

- source control
- issue reports
- screenshots shared publicly
- audit records
- CI logs

### Credential rotation

Use:

```sh
localmcp rotate
```

For the device-based Worker model, rotation replaces both Agent and MCP credentials in the Durable Object and disconnects existing Agent WebSockets. Previous credentials no longer authenticate after successful rotation.

Legacy single-user Worker deployments do not provide the same device-scoped rotation path. LocalMCP reports that limitation instead of claiming rotation succeeded.

## Local control IPC

Lifecycle and privileged local commands use the native local control endpoint:

- Unix domain socket on Linux/macOS
- named pipe on Windows

The control protocol requires an application-level random control secret stored in `~/.localmcp/control.secret`.

The secret protects commands including:

- status
- reload
- stop
- unlock
- lock
- rotate
- reregister Worker origin

The control secret is never exposed as an MCP tool and must not be logged.

Unix socket files are restricted to the current user where supported. Windows also relies on the state-file ACL hardening described above.

## Local Web control UI

`localmcp ui` starts a lightweight browser control plane bound explicitly to `127.0.0.1` on a dynamically allocated port. It does not bind to `0.0.0.0`, LAN interfaces, or public interfaces, and it does not create another Agent.

The browser-facing API is separate from the remote MCP data plane. The UI process uses the existing authenticated local lifecycle/control layer for Agent Start/Stop/Restart, status, lock/unlock, reload, credential rotation, Worker re-registration, and explicit MCP URL reveal.

The browser never receives `control.secret`. A browser session is established by a same-origin POST and represented by an ephemeral random `HttpOnly`, `SameSite=Strict` cookie. Control API requests require that session plus an exact same-origin `Origin` header. Query strings are rejected on control routes, and the server validates the loopback peer and expected `Host` value to reduce DNS-rebinding / cross-origin abuse.

The UI HTML and JavaScript contain no credentials. Ordinary status and action responses expose only the masked MCP URL. The complete credential-bearing MCP URL is returned only after an explicit local reveal action; reveal is recorded as a redacted audit event without the URL itself.

Configuration edits update the existing `localmcp.json`. The UI validates the complete candidate configuration with the existing config parser, preserves unrelated supported fields, writes through a restrictive same-directory temporary file, atomically renames it into place, and asks the running Agent to reload. Enabling privileged capabilities requires explicit confirmation. Workspace add/edit/remove/default changes use the same validation path and require explicit confirmation because they change the file-access boundary.

Worker re-registration is performed by the Agent through authenticated control IPC. The browser supplies only a validated Worker origin; Agent/MCP credentials and `LOCALMCP_REGISTRATION_TOKEN` are not returned to the browser or stored in normal configuration. If `LOCALMCP_WORKER_URL` is set, the UI treats the Worker origin as environment-managed and refuses to change it. Switching Worker replaces local registration state but does not claim to revoke a previous Worker's remote device registration; revoke or rotate that old registration separately when required.

Recent audit events are projected through a safe field allowlist before display. Secret/token/credential fields, URLs, raw shell commands, stdout/stderr, file contents, and arbitrary payloads are not exposed by the audit viewer.

The UI prominently warns that enabling Shell grants OS-level command execution under the LocalMCP process user's authority and that Workspace boundaries are not a Shell sandbox.

The local Web UI is intended to protect against remote MCP and cross-origin web access. Like the native control IPC, it is not a security boundary against a malicious process already running as the same local OS user.

## Desktop Shell

`localmcp desktop` starts the same loopback-only Control Center and then attempts to open it in a dedicated Edge / Chrome / Chromium app-mode window. It does not create another HTTP listener, Agent, authorization model, credential store, or browser extension.

The app-mode process is launched with `spawn` and an argument array rather than a shell command. The URL passed to the browser is only the ephemeral local Control Center URL and contains no MCP credential or control secret. `LOCALMCP_DESKTOP_BROWSER` is treated as a local OS-user process-launch preference; it is never accepted from the remote MCP data plane.

If no supported app-mode browser is available, Desktop Shell falls back to the platform's normal URL opener. This fallback does not weaken the existing loopback / Host / Origin / session checks.

Desktop Shell v1 is not a native system tray. It remains available as the zero-native-dependency fallback.

## Native Tray Shell

`localmcp tray` starts the same loopback-only Control Center and then launches a thin Tauri 2 native shell. The Rust process is only a window/tray host; it does not implement Agent authorization, hold MCP credentials, expose a second privileged backend, or create a LAN/public listener.

The Node launcher accepts only a local tray binary discovered under `src-tauri/target/{release,debug}` or an explicit local `LOCALMCP_TRAY_BINARY`. It passes only the ephemeral Control Center URL through `LOCALMCP_CONTROL_URL`. Both the Node launcher and Rust shell require the URL to use `http://127.0.0.1:<port>/` with no credentials, query, or fragment.

The Tauri WebView navigation callback restricts navigation to the same loopback host and port. Tauri capabilities are empty, so the loaded Control Center page is not granted native Tauri commands. The existing Control Center Host / Origin / session / control-IPC protections remain authoritative.

Closing the native window hides it to the tray. Tray Quit ends the native shell and closes only its corresponding Control Center HTTP host; it does not stop a separately running LocalMCP Agent. Source control excludes Rust `target/` output, generated schemas, and generated desktop bundle resources.

## Windows desktop distribution

The Windows NSIS build embeds a Node runtime, compiled LocalMCP `dist/`, skills, and production dependencies as application resources. End users do not need to install Node, npm, or Rust to run the packaged desktop app.

When `LOCALMCP_CONTROL_URL` is absent, the Tauri shell starts the bundled Node runtime with `desktop-host`. The host creates the same loopback-only Control Center and prints only its ephemeral loopback URL to the parent process. The Rust launcher validates that URL before creating the WebView. The bundled Node process is started with the Windows `CREATE_NO_WINDOW` flag and its stderr is redirected to the application log directory.

The installer resource path returned by Windows may use a verbatim `\\?\` prefix. The launcher normalizes that prefix before passing the Node script path to Node.js because Node 24 does not reliably accept a verbatim Windows path as its main script entry. The normalization changes path representation only; it does not broaden resource lookup or accept an external path.

Remote MCP-triggered shell/process work also uses hidden-window process creation on Windows. This prevents transient console windows without changing captured stdout/stderr, stdin, exit codes, timeouts, or process-tree termination. External MCP stdio transport already enables `windowsHide` in the upstream MCP SDK.

Native installers and executables remain build artifacts and should be published through release artifacts rather than committed to normal source history.

## Public relay trust

The default public Worker is convenient, but it is part of the trusted computing base.

It terminates TLS and relays MCP payloads in plaintext inside the Worker execution environment. LocalMCP does not claim end-to-end encryption between ChatGPT and the local Agent.

For repositories, credentials, source code, or environments with elevated confidentiality requirements, self-host the Worker and control its Cloudflare account, routes, secrets, and access policy.

## Protecting self-hosted registration

A self-hosted Worker can require a registration token so arbitrary Internet users cannot continuously create new device registrations.

The Worker accepts:

```text
REGISTRATION_TOKEN_HASH
```

as the SHA-256 hex digest of the raw registration token.

The local Agent sends the raw token in the HTTP `Authorization` header through:

```text
LOCALMCP_REGISTRATION_TOKEN
```

The token is never placed in the registration URL.

One way to generate a token and its hash:

```sh
node -e "const c=require('node:crypto');const t=c.randomBytes(32).toString('hex');console.log('token='+t);console.log('sha256='+c.createHash('sha256').update(t).digest('hex'))"
```

Configure the Worker with the printed `sha256` value as `REGISTRATION_TOKEN_HASH`, then start the local Agent with the corresponding raw token in `LOCALMCP_REGISTRATION_TOKEN`.

When `REGISTRATION_TOKEN_HASH` is not configured, registration remains intentionally open for compatibility.

## Security audit log

Security-relevant events are appended as JSON Lines to:

```text
~/.localmcp/audit.log
```

Events include:

- Agent start/stop
- lock/unlock/expiry
- configuration reload
- credential rotation
- Worker registration
- privileged tool attempts
- privileged tool success/failure/denial
- tool name
- workspace when applicable
- duration and denial reason when safe

Audit logging intentionally excludes:

- MCP tokens
- Agent tokens
- control secrets
- complete MCP URLs
- file contents
- command stdout/stderr
- raw shell command strings
- arbitrary secret-bearing payloads

Audit failure must not crash normal LocalMCP operation.

## Incident response

If a credential may have been exposed:

1. run `localmcp lock`
2. run `localmcp rotate`
3. replace any separately managed Worker registration token if necessary
4. review `~/.localmcp/audit.log`
5. restart the Agent to force a LOCKED state

If the local OS account itself is compromised, LocalMCP's local lock and state-file protections are not a substitute for operating-system account security.

## Known limitations

- Shell execution is not sandboxed by the workspace.
- External MCP servers run with the current OS user's authority.
- The Worker relay is trusted infrastructure, not end-to-end encrypted transport.
- Windows ACL hardening is best effort and depends on the host environment.
- The lock gate protects privileged LocalMCP operations from remote use; it is not designed to defend against a malicious process already running as the same local OS user.
