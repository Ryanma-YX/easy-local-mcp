# Multi-Device Zones

Multi-Device Zones are the first management layer for grouping several Easy Local MCP devices behind the same Relay.

> This first version is a control-plane feature. Devices in a Zone are managed together, but each device still keeps its existing per-device MCP URL. A unified Zone MCP connector/router is planned separately.

## What a Zone provides

A Zone stores only management metadata and credential hashes in a dedicated Cloudflare Durable Object:

- Zone name
- administrator credential hash
- joined device IDs and display names
- platform / architecture / version metadata
- one-time join-code hashes and expiration times

The existing per-device `McpRelay` Durable Objects remain unchanged and continue to isolate agent and MCP credentials.

## Open the Zone manager

On a Relay that includes Zone support, open:

```text
https://your-relay.example/admin
```

The page can:

- create a Zone
- generate a one-time join code
- list devices and their current online/offline state
- rename a device
- revoke a device

If the Relay is protected with `REGISTRATION_TOKEN_HASH`, creating a Zone requires the corresponding registration token.

## Join another device

1. Configure the new device to use the same Relay.
2. In the Zone manager, create a one-time join code.
3. Stop Easy Local MCP on the device if it is already running.
4. Stage the join:

```bash
localmcp join <zone-code>
```

5. Start Easy Local MCP normally.

The join code is single-use and expires after 10 minutes by default. A successful join creates fresh per-device agent and MCP credentials and then deletes the pending local join code.

The device display name defaults to the local hostname. The Zone administrator can rename it later.

## Revocation

Revoking a device from the Zone does two things:

1. removes it from the Zone device list;
2. invalidates that device's Relay agent and MCP credentials and disconnects its active agent WebSocket.

The revoked device must register or join again before it can reconnect.

## Credential separation

Zone administration does not reuse device MCP credentials.

- **registration token**: optionally protects creation/registration operations on a self-hosted Relay
- **Zone admin token**: manages one Zone
- **join code**: short-lived, single-use credential for adding one device
- **agent token**: authenticates one local Agent to its per-device Relay
- **MCP token**: authenticates one MCP client to its per-device Relay

Keep the Zone admin token private. The Relay stores only its SHA-256 hash and cannot recover the original token.

## Current limitation

A Zone does **not** yet expose one shared MCP URL for all devices. ChatGPT still connects to individual device URLs in this version.

The next layer can add a Zone MCP router with device-aware tools such as `list_devices` and a `device` selector while retaining the same per-device security boundaries.
