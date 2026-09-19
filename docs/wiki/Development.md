# Development

## Requirements

Core development:

- Node.js 22+
- npm

Desktop development:

- Rust stable
- Tauri toolchain requirements

Windows installer builds additionally require:

- Visual Studio 2022 / MSVC
- Windows SDK

## Install dependencies

```powershell
npm ci
```

## Type and worker checks

```powershell
npm run check
```

## Test suite

```powershell
npm test
```

The test suite covers the local server, security boundaries, Relay framing, Worker behavior, desktop launch behavior, native control IPC, and cross-platform behavior.

The GitHub Actions matrix runs supported tests on:

- Ubuntu
- macOS
- Windows
- Node.js 22
- Node.js 24

## Build Node output

```powershell
npm run build
```

Compiled JavaScript is written to `dist/`.

## Desktop / tray

Check the Rust tray project:

```powershell
npm run tray:check
```

Build the native tray:

```powershell
npm run tray:build
```

Build the Windows desktop installer:

```powershell
npm run desktop:bundle
```

## Worker

Run a development Worker:

```powershell
npm run worker:dev
```

Deploy:

```powershell
npm run worker:deploy
```

## Before committing

Recommended minimum:

```powershell
npm run check
npm test
git diff --check
```

## Important design rule: discovery vs execution

Connector capability discovery and runtime authorization are intentionally separate.

`tools/list` exposes capabilities that are enabled in configuration, including privileged capabilities while the Agent is LOCKED.

`tools/call` performs the actual runtime authorization check and rejects privileged execution while LOCKED.

Do not reintroduce LOCK-state filtering into tool discovery; doing so prevents ChatGPT from refreshing the complete connector capability set.

## Repository structure

Important areas:

- `src/`: Agent, local MCP server, security, desktop/control logic
- `worker/`: Cloudflare Worker / Durable Object Relay
- `src-tauri/`: native desktop shell and tray
- `test/`: cross-platform and integration tests
- `skills/`: built-in skills
- `scripts/`: build/deployment helpers
- `docs/`: project documentation and Wiki source

## Documentation workflow

The canonical Wiki source is kept under `docs/wiki/`.

When Wiki changes are approved, publish those Markdown files to the GitHub Wiki repository. Keeping the source in the main repository makes Wiki changes reviewable through the normal Git workflow before publication.
