# LOCAL-CONTROL-TRAY-V1

## Status

Implemented on branch: local-control-tray-v1
Baseline: local-control-desktop-v1

Tray v1 adds a thin Tauri 2 native shell over the existing Easy Local MCP Control Center. It does not replace the Node Agent, Control Center, authorization model, or control IPC.

## Toolchain

Validated on Windows 10:
- Visual Studio 2022 Enterprise 17.14
- MSVC v143 / 19.44
- Windows SDK 10.0.26100
- Rust stable 1.98.1
- Tauri 2.11.5

The Windows 11 SDK is used as the compiler SDK while the development host remains Windows 10.

## Commands

Build:
    npm run tray:check
    npm run tray:build

Launch:
    localmcp tray

The source-development build expects src-tauri/target/release/easy-local-mcp-tray.exe or the debug equivalent. LOCALMCP_TRAY_BINARY may point to a trusted local binary.

## Runtime architecture

localmcp tray starts one Node loopback Control Center and one Tauri native window/tray shell. The Rust side receives only LOCALMCP_CONTROL_URL=http://127.0.0.1:<port>/.

The Rust shell does not receive MCP URL credentials, control.secret, agentToken, mcpToken, or the Worker registration token.

## Tray behavior

- left-click tray icon shows/focuses the Control Center
- Show Control Center menu item
- Hide Control Center menu item
- Quit Easy Local MCP Desktop menu item
- closing the native window hides it to tray
- Quit closes the Tauri shell and its Control Center HTTP host
- Quit does not stop a separately running Easy Local MCP Agent

## Security

Both the Node launcher and Rust shell only accept the initial URL shape http://127.0.0.1:<port>/ with no credentials, query, fragment, or non-root path.

The Tauri WebView navigation callback restricts navigation to HTTP on the same 127.0.0.1 host and port. Tauri capabilities are empty, so the loaded Control Center page is not granted native Tauri commands.

Privileged operations remain protected by the existing authenticated local control IPC, Agent authorization, LOCK / UNLOCK, and feature gates.

## Source-control policy

Do not commit:
- src-tauri/target/
- src-tauri/gen/

Rust target output is a local build cache and can become large. Native release executables should be distributed later through release artifacts or platform-specific packages rather than normal source history.

Tracked desktop resources are icon.png, icon.ico and icon.icns under src-tauri/icons.

## Validation

Completed:
- npm run check
- cargo check --manifest-path src-tauri/Cargo.toml
- cargo build --release --manifest-path src-tauri/Cargo.toml
- npm test: 27 passed, 0 failed
- native smoke test started the loopback Control Center and release Tauri tray binary successfully

Initial Windows release build took 2m 41s. After dependencies were compiled, incremental cargo check completed in about one second.

## Distribution still pending

Tray v1 is currently a source-development feature. A future distribution phase should use GitHub Release platform binaries, platform-specific optional npm packages, or an installer. End users should not need Rust merely to run Easy Local MCP Desktop.
