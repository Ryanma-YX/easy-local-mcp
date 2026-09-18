# LOCAL-CONTROL-DESKTOP-V1

## Status

Implemented on branch:

```text
local-control-desktop-v1
```

Desktop Shell v1 wraps the existing LocalMCP Control Center in a dedicated browser app-mode window without introducing a new backend, authorization layer, or native dependency.

## Goal

Move LocalMCP from “CLI command opens a browser tab” toward a desktop-control experience while keeping the security-critical implementation in the existing local Control Center and authenticated Agent IPC.

## Command

```sh
localmcp desktop
```

This command:

1. initializes LocalMCP if necessary
2. starts the same loopback-only Control Center used by `localmcp ui`
3. does not automatically open the ordinary browser flow
4. launches a dedicated browser app-mode window when possible
5. keeps the UI host running until the command is stopped

## Platform strategy

### Windows

Preferred order:

- Microsoft Edge under Program Files / LocalAppData
- Google Chrome under Program Files / LocalAppData
- `msedge.exe` from PATH
- `chrome.exe` from PATH

The app window is launched with:

```text
--app=http://127.0.0.1:<port>/
--new-window
```

If app mode cannot be launched, the shell falls back to the normal Windows URL handler.

### macOS

Preferred:

- Microsoft Edge app mode
- Google Chrome app mode

Fallback:

- `open <local-ui-url>`

### Linux

Preferred:

- microsoft-edge
- google-chrome
- chromium
- chromium-browser

Fallback:

- `xdg-open <local-ui-url>`

## Explicit browser override

The local user may set:

```text
LOCALMCP_DESKTOP_BROWSER
```

to an Edge/Chrome/Chromium executable path or command name.

The value is passed directly to `spawn` with an argument array. It is never composed into a shell command.

## Security properties

Desktop Shell v1 does not change the Control Center security boundary:

- UI still binds only to `127.0.0.1`
- UI URL contains no MCP credential
- browser session remains short-lived and HttpOnly
- full MCP URL remains masked except explicit reveal
- Agent lifecycle and privileged actions still use authenticated local control IPC
- no LAN/public listener is added
- no shell interpolation is used to launch the browser
- no browser extension or remote automation permission is required

`LOCALMCP_DESKTOP_BROWSER` is a local process-launch preference and is therefore trusted at the same level as the local OS user environment.

## Current limitation

Desktop Shell v1 is not a native system-tray application.

Closing the app-mode browser window does not reliably indicate that the UI host should terminate because Chromium-family browsers may reuse an existing browser process.

For this reason v1 keeps the UI host attached to the `localmcp desktop` process.

## Next desktop phase

A future native wrapper should add:

- system tray icon
- Show / Hide Control Center
- Start with OS
- Quit LocalMCP Desktop
- optional Agent status indicator
- native folder picker for Workspace selection

Preferred implementation direction remains a lightweight native tray / Tauri-style shell over the same loopback Control Center.

It must not:

- reimplement authorization
- store another copy of MCP credentials
- expose remote administration
- bypass LOCK / UNLOCK
- create a second Agent

## Validation

Desktop Shell v1 should pass:

```text
git diff --check
npm run check
npm test
npm run build
npm audit --registry=https://registry.npmjs.org
```

Cross-platform tests verify:

- Windows Edge/Chrome app-mode candidate construction
- macOS app-mode launcher arguments
- Linux browser candidate order
- explicit browser override behavior
- system-browser fallback commands
- app-mode arguments contain only the local Control Center URL and not an MCP path
