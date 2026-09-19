# Self-hosted Relay

Easy Local MCP can use the prefilled public Relay for quick evaluation. That Relay is currently an upstream/community shared service, so its availability, capacity, and long-term continuity are outside this fork's control.

For regular or long-term use, a Relay under your own control is recommended. It can run on a machine you manage with a reachable HTTPS endpoint, on your own VPS, or on your own Cloudflare Worker.

Typical examples:

- company source code
- ERP / MES data
- internal documents
- credentials
- production administration

## Architecture

```mermaid
flowchart TD
    A[ChatGPT] -->|MCP| B[Your Cloudflare Worker / Relay]
    B -->|WebSocket| C[Easy Local MCP Agent]
    C --> D[Local capabilities]
```

The local Agent initiates the outbound WebSocket connection. No inbound port is required on the local machine.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ryanma-YX/easy-local-mcp)

After deployment:

1. Open the Worker in Cloudflare.
2. Go to **Settings → Domains & Routes**.
3. Copy the `workers.dev` URL.
4. Enter that URL in Easy Local MCP during first-run setup.

Example:

```text
https://easy-local-mcp-relay.YOUR-SUBDOMAIN.workers.dev
```

## Manual deployment

```powershell
npm ci
npm run worker:deploy
```

## Relay administration

The Zone management dashboard at `/admin` is fail-closed. Configure a dedicated Relay administrator credential before it can be used:

```text
RELAY_ADMIN_TOKEN_HASH
```

Generate a strong token and its SHA-256 hash, for example:

```sh
node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('ADMIN TOKEN: '+t);console.log('SHA256: '+c.createHash('sha256').update(t).digest('hex'))"
```

Keep the **ADMIN TOKEN** and configure only the **SHA256** value as the Worker secret/environment value `RELAY_ADMIN_TOKEN_HASH`.

After deployment, opening:

```text
https://YOUR-WORKER.workers.dev/admin
```

shows only the Relay Admin login page until a valid administrator session is established. The browser session is stored in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, while the Relay stores only the session hash.

The Relay Admin Token is separate from Zone Admin Tokens, Zone MCP connector tokens, Join Codes, and device Agent/MCP credentials.

For the complete design, see [`docs/RELAY-CONTROL-PLANE-ARCHITECTURE.md`](../RELAY-CONTROL-PLANE-ARCHITECTURE.md).

## Registration protection

A self-hosted Worker can use registration protection with:

```text
REGISTRATION_TOKEN_HASH
```

The Easy Local MCP first-run setup accepts the corresponding raw registration token.

The raw registration token:

- is not included in the MCP URL
- is not written to the ordinary configuration file
- is not written to the audit log
- is removed after registration credentials are persisted

## Verify the Worker

A basic health check:

```sh
curl https://YOUR-WORKER.workers.dev/healthz
```

A healthy Relay should return a JSON response indicating that the service is available.

## Switching Relay

Changing a Relay is a security-sensitive operation because device credentials are tied to registration.

Use the Control Center setup/reconfiguration flow rather than manually copying credentials between Workers.

## Trust boundary

The Relay is part of the trust boundary. Self-hosting gives you control of that intermediary, but the current design should not be treated as end-to-end encryption between ChatGPT and the local Agent.

See [[Security Model]] for the rest of the security model.
