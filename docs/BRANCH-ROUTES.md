# Easy Local MCP development routes

Every active assistant-created development head belongs under `copilot/feature/**`, `copilot/fix/**` or `copilot/inter/**`. The source of truth for integrated local testing is `staging`; `master` remains unchanged.

## 1. Agent Sessions: `copilot/feature/agent-sessions`

Starts at `master`. Contains Agent Session request/approval, owner-selected duration, per-connector capacity, explicit UI tool-group snapshots, preserved legacy approved wildcard records (no new wildcard grants) `tools:["*"]`, owner Edit and repeatable Extend, and best-effort session-specific in-flight Revoke. It does not depend on Machine Lock work or staging.

## 2. Machine Lock: `copilot/fix/*` and `copilot/feature/*`

- `copilot/fix/unlock-lease-revocation` starts at `master`; fences delayed privileged lease writes from restoring a revoked lock, including Agent startup.
- `copilot/feature/remote-lock` starts **from that lease-revocation branch**; adds the owner Remote Lock control and absolute, nonrenewable Remote Unlock choices of 5/15/30/60 minutes. Local CLI unlock renewal is unchanged. A fresh Remote Unlock rotates the generation so prior delayed renewals cannot override its selected deadline.

No Session branch is an ancestor of either Lock branch. Both routes can be inspected independently.

## 3. Integration: `copilot/inter/session-lock`

Starts from the Session branch and has merge parents for the Lock branch and the existing signed Linux reliability foundation. Contains cross-route tests, Linux startup fence compatibility, and shared owner-control documentation. Work that depends on more than one route belongs under `copilot/inter/**`; do not create `copilot/test/**` branches for combined work.

## Staging rules

- Feature work and its tests/docs are committed to the relevant route, **never directly to staging**.
- `staging` is reconstructed from `master` with separate first-parent **merge commits only**: existing dependency refresh, original owner-signed Linux commits, generic lease fix, Remote Lock policy, Agent Sessions, and cross-feature integration. The old standalone repository LF-policy merge is intentionally excluded.
- Do not base new single-route branches on `staging`. Merge each route back for integrated local tests; inter branches may depend on multiple feature heads.
- Preserve owner-signed history; do not change `master`, push, deploy, restart the Agent, change secrets, or use Remote Unlock without separate authorization.
- Superseded individual topic pointers were archived, but the active `copilot/feature/**` and `copilot/fix/**` categories remain in use. Obsolete `copilot/integration/**`, `copilot/rebuild/**` and `copilot/test/**` categories were replaced by `copilot/inter/**`. Preserve unrelated branches; renaming is preferred over deleting. Recovery refs and a Git bundle are retained in `/data/copilot/archive/easy-local-mcp/cluster-reorg-20261015-1118/` and `/data/copilot/archive/easy-local-mcp/branch-naming-lf-removal-20261015/`.

New assistant merges and commits identify as `GPT-6 Sol <gpt-6-sol@chatgpt.invalid>`. This is Git author/committer attribution, **not a cryptographic signature**. The owner's original cryptographically signed Linux commits remain unchanged; the owner's signing key is not available and has not been used.
