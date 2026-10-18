# ADR-0003: Sync scopes — numbered change feeds per scope

- **Status:** Accepted
- **Date:** 2026-10-14
- **Resolves:** HLD §4 open decision on the change feed; HLD §11 ADR-0003
- **Changes requirements:** adds REQ-059 to REQ-062

## Context

Pull sync (HLD §4) tells a device what changed since it last synced. It must deliver:

- the user's own records to all of their devices (REQ-006, REQ-033, REQ-046);
- records other members add to shared albums: items, comments, reactions (REQ-039, REQ-042, REQ-043);
- friend requests and album shares from other users (REQ-034, REQ-035);
- loss of access, so removed members stop seeing an album (REQ-044).

The HLD named two candidates, and both fall short:

- **Index on `(owner, updatedAt)`.** It returns only records the user owns, so shared-album content from other members never arrives. Worse, the cursor is a timestamp. Timestamps come from different Lambda instances, and the index updates with a delay, so a change can become visible with a timestamp just behind a cursor the device has already passed. That change is then skipped forever.
- **DynamoDB Streams copying changes into a per-user log.** It handles sharing, but it is asynchronous, multiplies every write by the number of members, and has to copy a whole album into a new member's log when they join.

More constraints:

- Connections are slow and drop often, so pull responses must come in small pages that are safe to request again.
- Devices can stay offline for weeks, so a cursor may be older than the oldest deletion record the server still keeps (REQ-048).

Decision drivers, in priority order:

1. Never miss a change.
2. Shared content reaches every member, and losing access takes effect.
3. A change and its feed position are committed together, synchronously, with no pipeline in between.
4. Small, repeatable pull pages for slow links.
5. Serverless and scale-to-zero, with few moving parts.

## Decision

### 1. Every record belongs to a sync scope

| Scope | Key | Contents |
|---|---|---|
| **Personal** | `user#{sub}` | Profile and settings; photos, videos and notes not in any album; the user's memberships (one record per album they belong to); friend requests and friendships involving the user; public links the user created. |
| **Album** | `album#{albumId}` | The album record; every item in the album, whoever added it; comments and reactions on the album and its items; the member list. |

Most records live in exactly one scope. A record that concerns two parties has one copy in each of their scopes, written in the same transaction:

- a membership: in the album scope and in the member's personal scope;
- a friendship: in both users' personal scopes.

Moving an item into, out of or between albums (REQ-009) is one transaction. The item leaves the old scope, leaving a *moved-out* marker behind, and enters the new scope.

### 2. Each scope numbers its changes

Each scope has a **head** record holding the number of its last committed change. To write a record in scope S:

1. Read S's head, n.
2. In one `TransactWriteItems` call:
   - set the head to n+1, on condition that it still equals n;
   - write the record with `seq = n+1`, together with the version check that detects conflicts (REQ-030; scheme decided in ADR-0004).
3. If the head condition fails, another write took n+1 first, so re-read the head and retry. If the version check fails, it is a conflict.

Writes within one scope are therefore serialized, and change numbers become visible strictly in order. Devices read a scope ordered by `seq` with **strongly consistent** reads. DynamoDB supports those on the base table and on local secondary indexes, but not on global ones; the key design is left to the data-model LLD. Change n+1 can never be visible before change n, so a cursor never skips anything.

A write that touches two scopes (decision 1) includes both heads in the same transaction.

### 3. The feed is current state, not history

A record carries the number of its latest change, so the "feed" is simply the scope's records ordered by `seq`. A pull returns each changed record once, in its current state, and nothing grows without bound. Deletions are tombstones (REQ-045, REQ-046) and come back like any other change. Conflicts are resolved per record (REQ-031), so the history of edits isn't needed.

### 4. Pulling

`POST /sync/pull` sends one cursor per scope the device knows about, e.g. `{"cursors": {"user#…": 1830, "album#…": 412}}`.

The server:

- checks each requested scope against the user's memberships;
- queries the readable scopes in parallel from their cursors;
- returns the changed records, the new cursors, a `more` flag when a page limit was reached, and a status per scope:
  - `ok`;
  - `resync` (decision 6);
  - `gone`: the user can no longer read the scope.

Pages are limited by size. The client picks the size from measured throughput, as it does for upload chunks (ADR-0001), within a server maximum. It advances a cursor only after storing the page locally. Pull is read-only, so a lost response is simply requested again.

**New scopes** are found through the personal scope. When a new membership record arrives, the device adds that album's scope with cursor 0. The initial download is just a normal pull from 0.

The client pushes its outbox before pulling. Its own changes come back with new numbers; it recognises them by version and just advances the cursor.

### 5. Losing access

When the owner removes a member, or deletes the album:

- **Access ends at once.** The membership is tombstoned in both scopes, so the next pull returns `gone` for the album scope (REQ-044).
- **Contributed items go back to their owner.** Each item the member contributed moves from the album scope to that member's personal scope, and the other members stop seeing it (REQ-059). Comments and reactions on a moved item exist only in the album's context, so they are tombstoned. A transaction holds at most 100 actions, so a background job does the moves in batches. The job is idempotent and resumable.
- **Deleting an album never deletes photos.** Every item, the owner's included, returns to its owner's personal library (REQ-060). To get rid of the photos, the user deletes them, which sends them to the trash as usual.
- **The removed member's devices** delete their local copy of the album, except for records the member owns. Those stay until they arrive in the personal scope.

What happens to a removed member's comments on items that stay in the album is left to the sharing LLD. For now they remain.

### 6. Purge horizon and resync

Deletion records (tombstones and moved-out markers) are kept for a retention period after the trash window ends (REQ-048), then removed. Each scope records a **purge horizon**: the highest change number among the deletion records removed so far.

A pull whose cursor is older than the horizon might have missed deletions, so that scope gets the status `resync` (REQ-062). The device then:

1. re-reads the scope from 0;
2. deletes local records of that scope that the full pass didn't return, except records with pending outbox changes, which are never discarded.

Devices that come back within the retention period never need a resync.

### 7. When devices pull

While the app is open and online, it pulls (REQ-061):

- when it opens or regains focus;
- when connectivity returns;
- after each push;
- on a periodic timer.

Other members' changes reach an open device within minutes. Live notifications are not part of the POC.

## Considered options

1. **Index on `(owner, updatedAt)`.** Rejected: it misses records owned by other members, and a timestamp cursor can skip changes.
2. **Index on `(scope, updatedAt)`, re-reading a few seconds of overlap on each pull.** This fixes sharing and needs no transactions. Rejected: it is correct only if the index delay and clock skew stay below the overlap, which nothing guarantees.
3. **DynamoDB Streams fanning changes out into per-user logs.** One cursor and one query per device. Rejected:
   - it is asynchronous;
   - every write is multiplied by the number of members;
   - joining an album means copying the whole album into the new member's log;
   - it adds a stream processor to run.

   If users ever have hundreds of albums, a lighter version of this idea could help: a per-user summary of *which scopes changed*, so pulls skip unchanged scopes.
4. **Append-only log of every change.** It grows without bound and replays edits the device doesn't need. Current state is enough, because conflicts are resolved per record.
5. **One global change counter.** A single hot record that every write in the system contends on.
6. **Live notifications over WebSocket.** Changes would appear within seconds, at the cost of connection tracking, a fan-out step on every write, and always-open sockets on flaky links. Deferred.
7. **Other ways to handle contributed items when a member loses access.**
   - Leaving the items in the album with the album owner taking over: the contributor would lose their own photos.
   - Letting both sides keep the items: media deletion would need reference counting.

## Consequences

- **Good:**
  - cursors are exact, with no clock or index-delay assumptions;
  - sharing, joining and losing access fall out of the scope model;
  - a change and its position are committed together;
  - no extra infrastructure;
  - pulls are small and safe to repeat.
- **Bad:**
  - writes within one scope are serialized. That is harmless at human write rates, but a very busy album will see retries;
  - transactional writes cost twice the write units. Metadata records are around 1 KB, so this is cheap;
  - each pull runs one query per scope. That is fine for tens of albums per user, and the summary in option 3 covers hundreds;
  - strongly consistent ordered reads push the key design towards partitioning by scope. With a local secondary index, a scope's records are capped at 10 GB, which is millions of metadata records;
  - moving an item between scopes needs a marker plus two writes, and removing a busy contributor needs a background job.
- **Follow-ups:**
  - data-model LLD: keys, the index for ordered reads, the head record;
  - sync LLD: pull request and response format, page limits, resync procedure;
  - ADR-0004 (versioning), which plugs into the version check in decision 2.

## Parameters

Initial values, to be pinned in `docs/ear.md`:

| Parameter | Initial value | Basis |
|---|---|---|
| Pull page size | Adaptive, 16 KiB to 1 MiB | Same idea as upload chunks: small pages on slow links lose little when cut off. |
| Periodic pull interval | 5 minutes | Other members' changes appear within minutes. |
| Deletion-record retention after the trash window | 90 days | Devices offline for less than this never need a resync. |

## Validation spike

1. Several concurrent writers on one scope: how often does the head condition fail, and how many retries follow?
2. Pull latency for one request covering 50 scopes, with the queries run in parallel in one Lambda.
3. Strongly consistent ordered reads on the chosen index, and record sizes against the 10 GB per-scope cap.

## References

- [HLD](../hld.md) §4, §6, §8, §9; [requirements](../requirements.md) REQ-006, REQ-009, REQ-030–REQ-035, REQ-039–REQ-048, REQ-059–REQ-062.
- [ADR-0001](0001-resumable-media-upload.md) (page sizing follows the chunk-size approach); [ADR-0002](0002-guest-identity.md) (cursors are per device and per account).
- AWS, *Amazon DynamoDB Developer Guide*: transactions, read consistency, local secondary indexes.
