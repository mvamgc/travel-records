# ADR-0004: Field-level conflict detection with hybrid logical clocks

- **Status:** Accepted
- **Date:** 2026-10-14
- **Resolves:** HLD §4 open decision on the versioning scheme; HLD §11 ADR-0004
- **Changes requirements:** amends REQ-013, REQ-030, REQ-031 and a non-goal; adds REQ-063, REQ-064

## Context

Records are edited offline and synced later. The server must detect a change made concurrently on another device instead of silently overwriting it, and the user resolves real conflicts (REQ-030 to REQ-033).

Who actually produces concurrent changes:

- **One person on two devices.** Contributors can edit only their own items (REQ-040), and only the owner edits the album record, so different people rarely touch the same record.
- **The server itself.** `media-assembler` marks media `available` (ADR-0001), the access-loss job moves items back to their owners (ADR-0003), and the purge job removes deletion records.

Problems found in the review that this decision must solve:

- **False conflicts on retry.** A push applied on the server whose response was lost must not look like a conflict with itself when the client retries.
- **Several offline edits to the same record** must reach the server as one coherent change.
- **Delete vs edit** was unspecified.

ADR-0003 already writes each record in a transaction that also moves its scope's head. The conflict check is one more condition in that same transaction.

Decision drivers, in priority order:

1. Never silently overwrite a concurrent change to the same field.
2. No pointless prompts: edits to different fields, server-side changes and retries must not conflict.
3. Changes are stamped offline, at the moment of the edit, so edit times mean something to the user.
4. The check fits in the single conditional write of the ADR-0003 transaction.

## Decision

### 1. Hybrid logical clock stamps

Every device keeps a **hybrid logical clock** (HLC), and so does the server. A stamp has three parts:

| Part | Meaning |
|---|---|
| Physical time | Milliseconds since the Unix epoch, from the corrected wall clock. Never goes backwards. |
| Counter | Distinguishes stamps within the same millisecond. Also advances when the device's clock is behind a stamp it has received. |
| Node ID | The device ID (ADR-0002), or `server`. Breaks ties, so every stamp is unique. |

Stamps are compared by physical time, then counter, then node ID. When a device receives stamps in a pull, it moves its clock forward to at least the largest one. An edit made after seeing a change therefore always gets a larger stamp than that change.

**Clock guard:**

- Each sync response carries the server's time, and the device uses it to correct its own clock offset.
- The server rejects a push whose stamp is more than a set bound ahead of its own time, replying with its current time.
- The device then corrects its offset and re-stamps the rejected change. It was not applied, so re-stamping is safe.

This stops a device whose clock runs ahead from pushing everyone's stamps into the future.

The HLC code lives in one Rust crate, compiled to WASM for the client and natively for the Lambdas.

### 2. Every field carries a stamp

Each synced record stores, for every field, the stamp of the change that last set it. The record's last-modified time is its largest field stamp (REQ-013). Server-side writers stamp the fields they change with the server's clock.

### 3. What a push carries

A push operation contains:

- the record ID;
- the operation's stamp `h`, taken when the edit was made;
- for each changed field, the new value and its **base stamp**, meaning the field's stamp when the device last saw it.

Several offline edits to the same record **coalesce** into one operation. It carries the latest values, the stamp of the latest edit, and the base stamps from before the first local edit.

### 4. The server's check

Inside the ADR-0003 transaction, the record write carries one condition: **for every changed field, the current stamp equals the base stamp.**

- **Condition holds:** the server applies the values, sets each changed field's stamp to `h`, and takes the scope's next change number.
- **Condition fails:** it is a conflict on the fields whose stamps differ. Nothing in the operation is applied. The server returns those fields' current values and stamps, which DynamoDB can return when a condition fails.

Fields the operation doesn't change are never compared. Edits to different fields therefore never conflict, whether the other edit came from the user on another device or from the server (REQ-030).

**Creates** use the condition "record does not exist". IDs are client-generated (REQ-008), so a create never collides with another one.

### 5. Retries

The stamp identifies the change, so it also serves as the operation's ID. Each record keeps the stamps of its last few applied operations. If a push's stamp is on that list, the server answers "applied" with the record's current state. It does so even if later changes have touched the same fields since (REQ-064).

The list stays short because a device sends one operation per record at a time. It only has to outlast other devices' writes made while a response was lost.

### 6. Resolving a conflict

1. The client keeps its pending values next to the server's values (REQ-032). That record's operation is parked, while other records keep syncing.
2. The user chooses, field by field, between the two values, each shown with when it was edited, taken from the stamp's physical time (REQ-031).
3. The client sends a new operation with the server's stamps as base stamps and a fresh stamp. The result syncs to the user's other devices like any change (REQ-033).

Unresolved conflicts survive app restarts.

### 7. Delete vs edit

Deleting sets `deletedAt`, a field with its own stamp (REQ-045). An offline edit to other fields of the same item arrives later and applies normally. The item stays in the trash with the edit, so restoring it brings back the edited version. The editing device shows a notice such as "An item you edited was deleted on another device; it's in the trash" (REQ-063).

Restoring an item clears `deletedAt`. A restore on one device and a delete on another therefore change the same field, and that is a regular conflict.

An edit to an item that has already been purged gets the answer `gone`. The client offers to keep its copy as a new item; the details are in the sync LLD.

### 8. Stamps and scope numbers do different jobs

| | Scope change number `seq` (ADR-0003) | HLC stamp (this ADR) |
|---|---|---|
| Assigned by | the server, at commit | the device or server making the edit, at edit time |
| Ordered within | one scope | everything, causally |
| Used for | pull cursors | conflict detection, retry recognition, edit times |

Neither replaces the other.

## Considered options

1. **Per-record integer incremented by the server, plus separate operation IDs.** The simplest way to detect conflicts. Rejected in favour of HLC, because a stamp:
   - is assigned offline, at the moment of the edit;
   - gives meaningful edit times for the conflict screen and for last-modified display;
   - identifies the change, so no separate operation ID is needed;
   - would allow per-field "last write wins" later without changing the format.
2. **Version vectors (a counter per device).** They detect concurrency exactly without a central server. Not needed when the server is the authority, and they grow with every device that ever edited a record.
3. **Reusing ADR-0003's `seq`.** It restarts in every scope, so an item moved between albums could repeat an old value.
4. **Conflicts on the whole record.** Rejected: server-side fields such as media state, and edits to different fields, would trigger pointless prompts.
5. **Last write wins per field, using the stamps.** No prompts at all, but it silently drops one of two concurrent edits, which contradicts REQ-030 and REQ-031. Possible later for low-value fields.
6. **Other ways to settle delete vs edit.**
   - Asking the user: one more prompt.
   - Letting the edit restore the item: a deliberate delete could be silently undone.

## Consequences

- **Good:**
  - only concurrent changes to the same field conflict;
  - server-side changes never cause prompts;
  - retries are recognised without a separate ID;
  - changes are stamped offline with meaningful edit times;
  - a delete followed by an edit loses nothing.
- **Bad:**
  - clock handling: the future-stamp guard, offset correction, and re-stamping rejected changes;
  - a device with a badly wrong clock has its pushes rejected until it has learned its offset;
  - per-field stamps add a few tens of bytes per field to every record, plus the list of recent stamps;
  - the conflict screen works field by field.
- **Follow-ups:**
  - sync LLD: stamp encoding, the push request and response format, the per-field condition expression, conflict storage on the client, handling of purged items;
  - parameter values in `docs/ear.md`.

## Parameters

Initial values, to be pinned in `docs/ear.md`:

| Parameter | Initial value | Basis |
|---|---|---|
| Maximum accepted future skew | 5 minutes | Devices correct their offset on every sync, so honest drift stays well below this. |
| Recent applied stamps kept per record | 16 | One operation in flight per device per record; generous margin for other devices' writes. |

## Validation spike

1. A DynamoDB transaction whose update has a condition on several nested map paths (`fieldStamps.caption = :base1 AND …`) and returns the item when the condition fails.
2. One HLC crate building for `wasm32-unknown-unknown` and for the Lambda target, with identical stamp encoding.
3. Record size with per-field stamps on a typical item.

## References

- [HLD](../hld.md) §4, §6, §10; [requirements](../requirements.md) REQ-008, REQ-013, REQ-030–REQ-033, REQ-045, REQ-063, REQ-064.
- [ADR-0002](0002-guest-identity.md) (device ID as the node ID); [ADR-0003](0003-sync-scopes.md) (the transaction this check runs in).
- S. Kulkarni et al., *Logical Physical Clocks*, OPODIS 2014: the hybrid logical clock algorithm.
