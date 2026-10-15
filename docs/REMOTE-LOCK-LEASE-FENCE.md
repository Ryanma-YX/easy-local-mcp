# Remote Lock lease-renewal fencing

`lockLocal()` now advances a durable random generation in the local `unlock.fence` file **before** removing `unlock.json`. Explicit local/remote unlocks bind their lease to the generation they read, and automatic renewals preserve that lease's generation. Authorization rejects a lease with a stale generation, even if another OS process writes it after Remote Lock completes. Resetting the lease on Agent startup also advances the generation, preventing an orphaned process from reviving an old unlock.

This is not a Cloudflare lock-state store. It is local revocation metadata in the same protected OS-user directory as the existing unlock lease. The existing global Remote Unlock and per-AI Agent Session Approvals remain separate: Remote Lock does not revoke independently approved Agent Sessions. Local processes with full OS-user access to these files remain outside the protection boundary.

`test/remote-lock-fence.test.ts` runs against a disposable HOME and uses a real second process that writes an old lease after Lock returns, plus a burst of competing renewals. The test never touches the live Agent or its unlock state. A corrupt/unreadable generation prevents a new successful unlock rather than accepting stale leases.
