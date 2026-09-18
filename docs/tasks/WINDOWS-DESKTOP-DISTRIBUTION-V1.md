# WINDOWS-DESKTOP-DISTRIBUTION-V1

## Scope

Branch: `windows-desktop-distribution-v1`

Baseline: `master@3997018`

This phase turns the native Tray shell into a Windows installer that can run on a target PC without a separate Node or Rust installation, and removes visible background shell flashes on Windows.

## Windows hidden-process behavior

The following background paths now suppress Windows console windows:

- `run_command`
- `start_process`
- Easy Local MCP Agent startup
- Agent internal HTTP child process
- native Tray child process

The change only adds hidden-window process creation. It does not change:

- stdout/stderr capture
- stdin
- exit codes
- timeouts
- process-tree termination
- security authorization

The upstream MCP SDK already sets `windowsHide` for external stdio MCP servers.

A runtime verification started a real `cmd.exe` through `ProcessManager` and confirmed:

```text
name=cmd
main_window_handle=0
responding=True
```

## Installer architecture

The NSIS installer contains:

- Tauri 2 native shell
- bundled Node runtime
- Easy Local MCP compiled `dist/`
- Easy Local MCP skills
- production npm dependencies
- Node.js license metadata

The target PC does not need:

- Node
- npm
- Rust

Build:

```sh
npm run desktop:bundle
```

Output:

```text
src-tauri/target/release/bundle/nsis/Easy Local MCP_<version>_x64-setup.exe
```

## Bundled startup flow

When started from the npm/source workflow, the existing `LOCALMCP_CONTROL_URL` flow remains supported.

When the installed executable is started directly:

1. Tauri resolves its bundled resource directory.
2. It normalizes a Windows verbatim `\\?\` resource path to a normal Win32 path for Node compatibility.
3. It starts the bundled `runtime/node.exe` with `app/dist/index.js desktop-host`.
4. Node starts the same loopback Control Center.
5. Node prints one machine-readable line:
   `LOCALMCP_CONTROL_URL=http://127.0.0.1:<port>/`
6. Tauri validates the loopback URL.
7. Tauri opens the same restricted Control Center WebView.
8. Tray Quit terminates the bundled host.

The bundled host is started on Windows with `CREATE_NO_WINDOW`.

## Build resources

Generated bundle resources live under:

```text
src-tauri/resources/
```

Only `.gitkeep` is tracked. Generated content is ignored by Git.

The prepare script copies the current Node runtime and Easy Local MCP app files, then installs production dependencies using the lockfile.

## Installer smoke test

The NSIS installer was installed silently into an isolated worktree directory rather than over the active npm-linked Easy Local MCP installation.

The installation contained:

- `easy-local-mcp-tray.exe`
- `runtime/node.exe`
- `app/dist/index.js`
- production `node_modules`
- uninstaller

The installed executable was started without `LOCALMCP_CONTROL_URL` and remained running with no stdout/stderr crash, proving that the embedded Node host could bootstrap the Control Center.

The active npm-linked Agent was not restarted or replaced during the test.
