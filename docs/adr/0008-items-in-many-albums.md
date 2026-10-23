# ADR-0008: Items live in their owner's library; albums hold entries

- **Status:** Accepted
- **Date:** 2026-10-18
- **Resolves:** letting an item be in several albums, and building albums from travels
- **Changes requirements:** amends REQ-009, REQ-059, REQ-060, REQ-070; adds REQ-079 and REQ-080
- **Amends:** [ADR-0003](0003-sync-scopes.md) (where items live, and what losing access does); [ADR-0006](0006-public-media-location.md) (when a video's public copy is deleted); [ADR-0007](0007-travels.md) (the per-item cap now counts albums too)

## Context

A user wants to **build albums from travels**: create a new album, or add to an existing one, by picking one or more travels and choosing items from those travels only. The same photo will often belong in several albums, for example "Rome" and "Best of Italy". So an item must be able to be in **any number of albums**, not at most one (REQ-009).

Until now, an item in an album *lived in* that album's sync scope (ADR-0003). Several things depended on that:

- **Moving an item between albums** moved its record from one scope to another and left a moved-out marker behind.
- **A member losing access** got their contributed items moved back to their personal scope (REQ-059).
- **Deleting an album** returned every item to its owner (REQ-060).

An item in several albums can't live in several scopes at once. ADR-0007 already solved the same problem for travels, with entries that carry a copy of the item's metadata.

Decision drivers, in priority order:

1. An item is in any number of albums and travels, with one source of truth for its data.
2. One mechanism for albums and travels.
3. Album sharing, access loss and deletion stay simple and safe.

## Decision

### 1. Every item lives in its owner's personal scope

Photos, videos and notes always live in their owner's personal scope (`user#{sub}`), whatever albums and travels they're in. The item record is the single source of truth. Conflicts are detected only there (ADR-0004), and only its owner edits it.

### 2. Albums hold entries, exactly like travels

An `AlbumEntry` record in the album scope links one item to one album, using the mechanism of ADR-0007 decision 2:

- **Deterministic ID:** `{albumId}:{itemId}`. Adding the same item twice creates the same record.
- **A copy of the item's metadata** goes in the entry, so album members can see the item. The server rewrites the copy whenever the item changes, in the same transaction, including each scope's head.
- **The per-item cap** now counts **albums and travels together** (Parameters), so that transaction stays within DynamoDB's 100-action limit.
- **Media access:** the server issues presigned URLs to anyone who can read a scope with an entry for the item (ADR-0007).

**Adding** an item to an album creates an entry; **removing** it tombstones the entry. Item records never move between scopes, so ADR-0003's moved-out markers are no longer needed.

Comments and reactions on an item in an album are attached to its entry. They exist only in that album's context and are tombstoned when the entry is removed.

### 3. Sharing, access loss and deletion

- **Contributors** add their own items to someone else's album by creating entries (REQ-039). They can remove only their own entries and edit only their own items (REQ-040).
- **The album owner** can remove any entry. That never deletes the item.
- **A member losing access** has their entries removed. Their items never left their library (REQ-059). A member can have many entries, so the `access-loss` job removes them in batches.
- **Deleting an album** tombstones the album and its entries. No item is deleted, and items stay in their owners' libraries and in any other albums and travels (REQ-060).

### 4. Albums from travels

From travels that are in progress or finished, the user can:

- **create a new album** (REQ-079): pick one or more travels, then choose items for the album;
- **add to an existing album** (REQ-080): pick one or more travels, then choose from their items that aren't in that album yet.

In both cases:

- The picker shows **only the user's own** photos, videos and notes in the selected travels. Other members' items in a shared travel are visible but can't be picked, because they belong to their owners (REQ-040).
- Each chosen item gets an album entry; notes become notes attached to the album (REQ-010).
- The album keeps no link to the travels. Adding from travels again later simply offers whatever isn't in the album yet.

Like any album change, this works offline; the entries sync later.

## Considered options

1. **Keeping one album per item.** Rejected (user decision): the same photo naturally belongs in several albums.
2. **Making the first album an item's home, with entries for the other albums.** Rejected: two mechanisms side by side, and removing an item from its first album would mean moving its record.
3. **Copying items, media included, into each album.** Rejected: duplicates storage and gives each copy its own edits, so there is no single source of truth.
4. **Merging albums and travels into one kind of collection.** Rejected (user decision): they stay separate concepts and only share the entry mechanism.

## Consequences

- **Good:**
  - one entry mechanism for albums and travels;
  - item records never move;
  - access loss and album deletion only remove entries;
  - ADR-0003's moved-out markers go away;
  - an album can be built from travels freely.
- **Bad:**
  - every edit to an item rewrites its entry in each album and travel it's in;
  - one cap covers albums and travels together;
  - a user's personal scope now holds all of their items, so a first pull of it is larger;
  - entries duplicate item metadata.
- **Follow-ups:**
  - data-model LLD: one entry schema for albums and travels;
  - sync LLD: rewriting entry copies.

## Parameters

Initial values, to be pinned in `docs/ear.md`:

| Parameter | Initial value | Basis |
|---|---|---|
| Maximum albums and travels per item | 20 | The item, its scope head, and one entry plus one head per album or travel must fit in a 100-action transaction, with room to spare. Replaces ADR-0007's travel-only cap. |

## Validation spike

The ADR-0007 spike covers this too: one transaction that updates an item and its entries in 20 scopes.

## References

- [HLD](../hld.md) §2, §4, §5, §6, §8; [requirements](../requirements.md) REQ-009, REQ-010, REQ-039, REQ-040, REQ-059, REQ-060, REQ-070, REQ-079, REQ-080.
- [ADR-0003](0003-sync-scopes.md) (scopes), [ADR-0004](0004-conflict-versioning.md) (conflicts), [ADR-0007](0007-travels.md) (the entry mechanism).
