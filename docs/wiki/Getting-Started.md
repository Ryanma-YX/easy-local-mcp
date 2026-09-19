# Getting Started

## 1. Install

### Windows desktop

Download the latest Windows x64 installer from:

https://github.com/Ryanma-YX/easy-local-mcp/releases/latest

The installer bundles the runtime required by Easy Local MCP. The target machine does not need Node.js or Rust.

### Build from source

Requirements:

- Node.js 22+
- Rust stable for desktop builds
- Visual Studio 2022 / MSVC and Windows SDK for the Windows installer

```powershell
git clone https://github.com/Ryanma-YX/easy-local-mcp.git
cd easy-local-mcp
npm ci
npm run desktop:bundle
```

## 2. First launch

On first launch the desktop app starts the local Control Center first. It does not immediately register with a Relay.

Choose either:

- the prefilled public Relay for quick evaluation
- a Relay you control for regular, long-term, or sensitive use

The prefilled public Relay is an upstream/community shared service. Its availability and capacity are outside this fork's control. A self-hosted Relay can run on a machine you manage (with a reachable HTTPS endpoint), on your own VPS, or on your own Cloudflare Worker.

Then click:

```text
Save & Start Agent
```

The app saves the Relay configuration, registers the device when needed, starts the Agent, connects to the Relay, and produces the MCP URL.

## 3. Connect ChatGPT

1. In Control Center, click **Reveal / Copy MCP URL**.
2. Enable ChatGPT Developer Mode:
   https://chatgpt.com/#settings/Security?section=developer-mode
3. Open the connector creation page:
   https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins
4. Paste the complete MCP URL.
5. Set **Authentication** to **None**.
6. Save the connector.
7. Start a new chat and use the connector.

If ChatGPT hides the normal Create Connector entry, the direct URL above still opens the connector creation page.

## 4. LOCK / UNLOCK

The Agent starts **LOCKED**.

While locked, configured privileged tools are still visible to ChatGPT so connector capability refresh works correctly, but actual privileged execution is denied.

Use the local Control Center or CLI to unlock:

```powershell
easy-local-mcp unlock
```

Lock again immediately when needed:

```powershell
easy-local-mcp lock
```

## 5. Useful commands

```powershell
easy-local-mcp ui
easy-local-mcp status
easy-local-mcp url
easy-local-mcp unlock
easy-local-mcp lock
easy-local-mcp reload
easy-local-mcp rotate
easy-local-mcp stop
```

The legacy `localmcp` command is retained for compatibility.

## Next

- [[Security Model]]
- [[Configuration]]
- [[Self-hosted Relay]]
- [[Troubleshooting]]
