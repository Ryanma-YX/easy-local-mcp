# Remote Unlock and owner Agent Session controls (local review candidate)

## Machine Lock / Remote Unlock

Remote Unlock choices are **fixed hard deadlines**: 5, 15, 30 or 60 minutes from the successful Agent unlock. Privileged activity does **not** extend any Remote Unlock interval, including when `renewUnlockOnPrivilegedUse` is enabled. The Remote Lock operation advances the durable local revocation fence before deleting the lease; it does not revoke independent owner-approved Agent Sessions. Local CLI unlock renewal retains its separate original behavior. Authorization is rechecked for new work at the deadline; this does not retroactively undo side effects or guarantee stopping commands already running.

## Owner-approved Agent Sessions

Active sessions have exactly three owner actions:

- **Edit permissions** changes the effective tool grant while retaining the original token, authenticated connector, device/Zone scope and expiry. The original AI request remains visible. In-flight operations are deliberately not interrupted by Edit.
- **Extend** chooses 1–720 integer hours, replacing the hard expiry with *time of extension + chosen hours*. Extension is repeatable on active sessions only. The existing 24/48-hour idle protection is reset to *time of extension + configured idle hours*, never beyond the new hard deadline. There is no token rotation or automatic resurrection.
- **Revoke** permanently denies new authorization immediately and sends best-effort cancellation to currently pending/running requests associated with that session ID. Relay cancellation is isolated from other sessions, global Machine Lock/Unlock and ordinary local operations. Running `run_command` receives an abort signal and its owned process group is killed when possible; HTTP transport is aborted and the relay request returns an error. Already detached/background historical processes are deliberately not enumerated or killed. External MCP tools, file-system work already committed, non-cooperative subprocesses, delayed messages and network failures may prevent complete cancellation. Do not interpret the cancellation count as proof every child stopped.

**Revoke is an owner-directed brake, not an emergency VM kill switch.** The owner may revoke for any reason, including simply ending work. Its boundary is: newly authorized operations are denied; already-queued requests receive best-effort cancellation before execution (and a queued HTTP command whose disconnection is observed before it starts must be discarded); running work receives a best-effort termination request; completed actions cannot be undone. Detached/background processes, tunnels, and external side effects are not covered by a guarantee. The local HTTP child attaches its abort listener before waiting for the mutation queue and releases its queue position even if the request was cancelled. No new security action, Pause control or audit subsystem is introduced.

The backend `tools:["*"]` still grants **all current and future enabled tools** within the existing authorization boundaries. Relay Admin's All current and Read/Write/Delete/Execute/External MCP group shortcuts create **explicit snapshots of current tool names**. A previously approved wildcard stays a wildcard unless the owner actually changes its selection. Group summaries collapse exact matches; individual names can be expanded. No new audit subsystem, Pause/Resume control or emergency button exists.

## Review gate

This code is a LOCAL review candidate only. The deployed Agent/Worker still run older, uncorrected versions. Before any coordinated isolated deployment, independently review authenticated session ownership forwarding, cancellation ordering, revocation races, worker-to-Agent control trust, process termination isolation, DO storage marker cleanup, fixed deadlines under concurrent activity, owner admin session/CSRF checks, wildcard compatibility, P1 lease fencing and P2 shared-storage capacity. Re-run full serial tests, targeted process tests, then adversarial hosted isolated acceptance. Owner approval is required for any push, deployment, service restart or production change.
