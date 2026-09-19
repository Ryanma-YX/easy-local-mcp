# Configuration

The main configuration file is normally:

```text
~/.localmcp/localmcp.json
```

You can point to another file with `LOCALMCP_CONFIG`.

A minimal example:

```json
{
  "workspaces": {
    "project": "."
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
  },
  "skills": {
    "dir": "skills",
    "enabled": ["local-development"]
  },
  "mcpServers": {}
}
```

The full example is available in:

https://github.com/Ryanma-YX/easy-local-mcp/blob/master/localmcp.example.json

## Workspaces

`workspaces` defines the filesystem roots exposed to built-in file tools.

```json
{
  "workspaces": {
    "project": "D:/Source/project",
    "docs": "D:/Documents/project-docs"
  },
  "defaultWorkspace": "project"
}
```

Tool calls can select a workspace by name. If omitted, `defaultWorkspace` is used.

Built-in file tools enforce the selected workspace boundary.

## File permissions

File permissions are granular:

```json
{
  "features": {
    "files": {
      "read": true,
      "write": false,
      "delete": false
    }
  }
}
```

- `read`: browse, search, stat, and read
- `write`: create and modify
- `delete`: delete and move

Legacy `"files": true` is still accepted and enables read/write/delete together.

## Shell and processes

```json
{
  "features": {
    "shell": true,
    "processes": true
  }
}
```

Processes depend on shell being enabled.

Shell is not a workspace sandbox. Commands run with the current operating-system user's authority, so these capabilities are protected by LOCK / UNLOCK.

## Skills

```json
{
  "skills": {
    "dir": "skills",
    "enabled": [
      "local-development"
    ]
  }
}
```

Each skill is represented by a `SKILL.md` file under the configured skills directory.

## External MCP servers

Example:

```json
{
  "features": {
    "externalMcp": true
  },
  "mcpServers": {
    "computer": {
      "enabled": true,
      "command": "cua-driver",
      "args": ["mcp"]
    }
  }
}
```

External MCP servers are exposed through stable gateway tools rather than registering every external tool as a top-level Easy Local MCP tool.

The main gateway operations are:

- `list_mcp_servers`
- `list_mcp_tools`
- `call_mcp_tool`

External tool metadata is treated as untrusted metadata and does not grant authorization by itself.

## Environment overrides

Common environment variables include:

- `LOCALMCP_CONFIG`: alternate config file
- `LOCALMCP_ROOT`: override the default workspace root
- `LOCALMCP_SHELL=1`: enable shell
- `LOCALMCP_PORT`: local HTTP port
- `LOCALMCP_TOKEN`: local HTTP token
- `LOCALMCP_WORKER_URL`: Relay / Worker URL

## Reloading configuration

The Agent supports configuration reloads. You can also trigger a manual reload:

```powershell
easy-local-mcp reload
```

Invalid configuration should be corrected before reload. Use `npm run check` when developing the project itself.

## Security reminder

Configuration enables a capability, but privileged execution still requires the Agent to be locally unlocked.

See [[Security Model]].
