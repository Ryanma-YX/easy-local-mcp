# Agent Session Approval capacity and spam protection

One authenticated MCP connector is **not one identifiable AI**. A Zone MCP URL may be shared among ChatGPT conversations, so quotas are enforced for its authenticated connector identity (kind, Zone/device ID and credential hash), not for a model-supplied session label. Direct per-device connectors have their own quotas; aggregating several direct-device connectors into a Zone requires separate verified membership metadata and is not assumed here.

The Relay Admin Durable Object stores three logical pools in its existing storage namespace; no migration is required:

- **Pending:** At most 10 simultaneously pending, unexpired requests per authenticated connector. The 15-minute pending TTL remains, with 10 new requests per connector per rolling hour (expired request rows within that hour still count toward the anti-spam window).
- **Approved:** Independently limited to 64 simultaneously effective, owner-approved grants per connector; capacity is checked transactionally both when requesting and when the owner approves pending work. Approved grants do not occupy pending slots, and only the independent owner can create them by approving requests. Expired approved sessions no longer count toward that limit.
- **Expired/rejected/revoked:** Best-effort history. Expired pending entries are dropped after the rolling rate-limit window, terminal history is retained for up to 7 days when there is capacity, and up to 200 historical records are retained opportunistically (oldest are evicted first if necessary). Active grants and pending requests are never evicted to make space for audit history. Audit/history retention is NOT a legally complete audit log.

Bulk removal of old history is chunked into batches of at most 128 keys as required by Cloudflare Durable Object storage. The former **shared 300-record admission cap is removed**. A Zone's expired approval requests can no longer deny a new pending request to unrelated connectors. UI listings prioritize pending and approved entries before history; they currently show up to 200 records.

`test/agent-session-approvals.test.ts` independently reproduces 300 expired requests from one Zone and verifies another Zone can still submit, plus pending quotas, approved capacity independence, rolling rate limiting and pruning. Existing owner authorization, Zone/device scope and token hashing remain unchanged.
