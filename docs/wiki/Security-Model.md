# Security Model

Easy Local MCP is a high-privilege local Agent. It runs with the permissions of the current operating-system user, so its security model is designed around explicit capability configuration plus a separate local LOCK / UNLOCK gate.

## Two layers of authorization

A privileged tool must pass both checks:

1. the capability is enabled in configuration
2. the Agent is currently unlocked

This distinction matters for ChatGPT connector discovery.

### Tool discovery while LOCKED

Configured privileged tools remain present in the MCP tool list while the Agent is locked.

This allows ChatGPT to discover and refresh the complete configured connector capability set without requiring an Unlock first.

Tool visibility does **not** bypass authorization. Actual calls still go through the runtime authorization check and are denied while locked.

## Privileged capabilities

Privileged capabilities include:

- file write/create/edit
- file move/delete
- shell execution
- persistent process operations
- external MCP discovery/execution that requires privileged access

Read-only capabilities can remain available while locked when enabled.

## LOCK lifecycle

The Agent starts **LOCKED**.

Unlock is local-only and expires automatically. The Agent returns to LOCKED state after restart.

Useful commands:

```powershell
easy-local-mcp unlock
easy-local-mcp lock
```

## Workspace boundary

Built-in file tools are constrained to configured workspaces.

Shell is different: it is **not** a filesystem sandbox. A shell command runs with the current OS user's permissions and may access resources outside the configured workspace.

That is why shell execution requires explicit configuration and local Unlock.

## MCP URL

The complete MCP URL contains an access credential.

Do not:

- commit it to Git
- paste it into public issues
- expose it in screenshots
- put it in ordinary logs
- share it in public chat rooms

Use credential rotation if the URL may have leaked:

```powershell
easy-local-mcp rotate
```

## Local control channel

Control operations use authenticated local IPC. Sensitive operations such as Unlock, Lock, URL reveal, credential rotation, reload, and stop are not exposed as ordinary remote MCP tools.

## Relay trust

The Relay is a trusted intermediary in the current architecture. The prefilled public Relay is useful for quick evaluation, but it is an upstream/community shared service operated outside this fork. Its availability and capacity are therefore not guaranteed by this project.

For regular or long-term use—and especially for company source code, ERP/MES data, internal documents, credentials, or production systems—prefer a Relay you control. See [[Self-hosted Relay]].

## More detail

The repository-level security document remains the authoritative detailed reference:

https://github.com/Ryanma-YX/easy-local-mcp/blob/master/SECURITY.md
