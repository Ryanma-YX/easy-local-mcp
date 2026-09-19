# Troubleshooting

## ChatGPT does not show Create Connector

Use the direct connector creation page:

https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

Developer Mode settings:

https://chatgpt.com/#settings/Security?section=developer-mode

## ChatGPT cannot see all configured permissions while the Agent is LOCKED

Current Easy Local MCP behavior is designed so configured tools remain discoverable while LOCKED.

If privileged tools disappear from the connector capability list:

1. confirm you are running a build that includes the discovery/execution separation
2. verify the capability is enabled in `localmcp.json`
3. refresh the connector in ChatGPT
4. restart the Agent only if you changed the installed build

Unlock should be required for **execution**, not for capability discovery.

## A privileged tool is visible but returns a LOCK error

This is expected.

Visibility lets ChatGPT understand the connector capability set. Runtime authorization still blocks privileged operations while LOCKED.

Unlock locally:

```powershell
easy-local-mcp unlock
```

## Agent is running but the MCP URL is hidden

Use:

```powershell
easy-local-mcp url
```

or **Reveal / Copy MCP URL** in Control Center.

The URL is masked by default because it contains credentials.

## Relay does not connect

Check:

- Worker URL is correct
- the URL uses HTTPS
- registration protection token is correct when enabled
- the Agent is running
- the Worker health endpoint responds

Example:

```sh
curl https://YOUR-WORKER.workers.dev/healthz
```

## Changed Worker but old credentials are still being used

Relay registration credentials are persistent. Use the Control Center reconfiguration flow rather than only changing an environment variable.

If you are migrating manually, stop the Agent and preserve the old credential file before registering against another Worker.

## Configuration reload fails

Validate `~/.localmcp/localmcp.json`:

- valid JSON
- workspace paths exist and are directories
- `defaultWorkspace` names an existing configured workspace
- feature names are valid
- external MCP entries include a command

Then run:

```powershell
easy-local-mcp reload
```

## Shell works outside the configured workspace

This is expected.

Built-in file tools enforce workspace boundaries. Shell is not a filesystem sandbox and runs with the current OS user's permissions.

See [[Security Model]].

## A console window flashes on Windows

Current desktop builds start bundled/background processes with hidden-window behavior. If console flashing occurs, verify that you are using the current desktop release rather than an older linked CLI build.

## GitHub Actions fail only on Ubuntu/macOS for Windows path tests

Windows path generation must use Windows path semantics even when the test itself runs on another operating system. Code that constructs Windows targets should use `node:path.win32` rather than the host platform's default path functions.

## More help

When reporting a problem, include:

- Easy Local MCP version
- operating system
- Node version when running from source
- whether you use the public or self-hosted Relay
- the failing command or tool name
- sanitized logs with all MCP URLs, tokens, and credentials removed
