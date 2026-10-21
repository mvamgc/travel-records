# ADR-0007: Travels — time-based collections that overlap

- **Status:** Accepted
- **Date:** 2026-10-18
- **Resolves:** introduces the Travel concept
- **Changes requirements:** amends REQ-009, REQ-065, REQ-066; adds REQ-068 to REQ-078, REQ-081 and REQ-082
- **Amends:** [ADR-0003](0003-sync-scopes.md) (travel entries carry copies of item metadata in travel scopes)
- **Amended by:** [ADR-0008](0008-items-in-many-albums.md) (items can be in several albums too; the per-item cap counts albums and travels together)

## Context

A **Travel** is a trip with a start and an end:

- The user can plan it ahead, with a description and planned dates, and edit everything before, during and after the trip.
- Photos taken or added during the trip join it automatically.
- Travels can **overlap**: for example one travel per country, plus one for the whole trip.
- A travel can be private, shared with friends, or public, just like an album.
- In a shared or public travel, nothing is added automatically. The app asks about each picture, showing it full screen.

Two consequences shape the design:

- **One item, many travels.** Overlapping travels mean the same photo can be in several travels at once.
- **Members see items that live elsewhere.** An item's record lives in its owner's personal scope (ADR-0008), so members of a shared travel need a way to see it through the travel's own scope (ADR-0003).

Auto-add also has to work offline, on each of the owner's devices, and those devices must reach the same result.

Decision drivers, in priority order:

1. Nothing becomes visible to other people without the owner's explicit approval.
2. Auto-add is deterministic and works offline.
3. A travel fits the existing machinery: sync scopes (ADR-0003), per-field conflicts (ADR-0004) and public-link privacy (ADR-0006).
4. Albums and travels use the same entry mechanism (ADR-0008).

## Decision

### 1. A travel is its own entity and sync scope

Each travel has a scope, `travel#{travelId}`, holding:

- the travel record: title, description, start and end;
- its memberships and public link;
- comments and reactions on the travel and its entries;
- its entries (decision 2).

**Dates:**

- Start and end are **local calendar dates, optionally with times**, with no time zone. The end date is inclusive.
- They are compared with each item's *local* time, wherever the item was captured. "1–10 November" means those local days, whatever country each photo was taken in.
- A travel's status (planned, ongoing, finished) is worked out from its dates and today's date; it is not stored.

As with albums, a device discovers travels through membership records in the user's personal scope (ADR-0003). The owner has a membership record too.

An item can be in any number of travels (REQ-070). Since ADR-0008 it can also be in any number of albums, and albums use the same entry mechanism.

### 2. Membership through travel entries

A `TravelEntry` record in the travel scope links one item to one travel.

- **Deterministic ID:** `{travelId}:{itemId}`. Two devices that auto-add the same item create the same record. A create that finds an identical entry already there counts as applied, not as a conflict.
- **Origin:** each entry is marked `auto` (added by the rule in decision 3) or `manual` (added by the user or approved in review).
- **A copy of the item's metadata** (caption, times, geotag, media state) goes in the entry, so members can see the item without reading its home scope.
  - The item's own record stays the single source of truth. Conflicts are detected only there (ADR-0004), and nobody edits the copies.
  - When an item changes, the server rewrites the copy in every entry for that item, in the same transaction as the item and including each travel scope's head.
  - A DynamoDB transaction holds at most 100 actions, so an item can be in at most a capped number of albums and travels together (ADR-0008).
- **Media access:** the server issues presigned URLs to anyone who can read a scope containing the item: its home scope, or an album or travel scope with an entry for it (ADR-0008).

This amends ADR-0003 decision 1. Besides records that concern two parties, an item's metadata can now also appear as copies in travel scopes.

### 3. Auto-add rule (private travels only)

An item of the owner — a photo, video or note — **belongs** to a private travel if both of these hold:

- its **local capture time** falls within the travel's dates, **or** its **local added time** (when it was created in, or imported into, the app) does;
- the owner hasn't excluded it from that travel.

**Capture time** is the EXIF original date/time for photos and videos (local wall-clock time), and the creation time for notes. An item without one uses its added time. Both times are stored on the item (HLD §6).

**Overrides:**

- *Removing* an auto-added item creates a `TravelExclusion` record in the **owner's personal scope**. Members never see it, and the rule never adds that item to that travel again.
- *Adding* an item from outside the dates creates a `manual` entry. The rule never removes manual entries.

**When the rule runs:** any of the owner's devices re-applies it offline:

- when an item is added or imported;
- when an item's capture time changes;
- when a travel's dates change, whether edited locally or received in a pull;
- when exclusions change.

It adds `auto` entries for items that qualify and removes `auto` entries that no longer qualify. Deterministic IDs make re-running it on several devices harmless.

### 4. Changing a travel's dates

Dates can change at any time (REQ-069). What happens to the entries depends on the travel:

| Travel | What a date change does |
|---|---|
| **Planned** (starts in the future) | Nothing has been captured in its dates yet, so the rule is re-applied without asking. Entries added by hand stay. |
| **Private, in progress or finished** | Before saving, the editing device works out the effect and asks, for example: "The new dates will add 34 items and remove 12." **Apply** saves the dates and updates the entries; **Cancel** keeps the old dates. Only `auto` entries are removed; `manual` entries always stay (REQ-081). |
| **Shared or public** | Nothing is added or removed automatically (REQ-082). Items that newly qualify go into their owners' review queues (decision 5). If entries now fall outside the dates, the owner is asked, for example: "12 items are now outside the dates. Remove them from the travel?" They can remove them all or keep them. |

The owner's other devices receive the new dates in a pull and re-apply the rule without asking, because the owner already confirmed on the editing device. Another device may hold items the editing device hasn't seen yet, such as ones created offline; the same rule adds or removes those.

Every entry in a shared travel was approved in a review (decision 5), so it is `manual`, and a date change never removes it silently.

### 5. Shared and public travels: review instead of auto-add

While a travel has other members or an active public link, **nothing is added automatically** (REQ-075).

- **Review queue:** items that would qualify under decision 3 go into a queue on the device of the **item's owner**. That covers the travel owner and also contributors, for their own items.
- **Full screen, one at a time:** each item is shown full screen, in good resolution, from the best version already on the device: the original if it's still there, otherwise the preview. The original is never downloaded just for review, so reviewing works offline. That means previews must look good full screen (Parameters).
- **Add** creates a `manual` entry. **Skip** creates a `TravelExclusion` in the owner's personal scope, so the item is never offered again for that travel and other members never learn it exists (REQ-077).

**Making a private travel shared** (adding the first member or creating a public link) first opens the same review over the entries already in the travel (REQ-076):

1. The owner approves or declines each existing item, full screen. Approved entries become `manual`.
2. Declined items have their entries removed and get an exclusion.
3. Only then are the membership or public link created.

The review can be done offline. Sharing needs the network anyway (REQ-003), so it is applied once the review is complete and the device is online.

**Returning to private** (removing the last member and the link) turns auto-add back on for items from then on. Earlier skips still stand.

### 6. Access, removal and deletion

- **Roles** are viewer and contributor, as for albums (REQ-034). Contributors add their own items, through review.
- **Removing entries:** contributors can remove their own entries. The travel owner can remove any entry. An entry is a reference, so removing it never deletes the item.
- **A member losing access** has their entries removed. Their items stay in their own library, so there is nothing to give back (compare REQ-059).
- **Deleting a travel** tombstones the travel and its entries and **never deletes items** (REQ-078).
- **Location:** members see location just as the owner does (REQ-065). Public links follow ADR-0006: previews only, no geotags, no map (REQ-066).

## Considered options

1. **Merging travels and albums into one kind of collection.** Rejected (user decision). It would rework REQ-009 and the album scope rules.
2. **A travel that groups albums.** It keeps one album per item, but overlapping travels would then have to share albums.
3. **Computed membership with no stored records.** Devices would work out membership from the dates alone. Rejected:
   - shared travels need explicit, approved records;
   - the owner's other devices need the exclusions;
   - members need the copies of item metadata.
4. **Entries holding only references, with members reading items' home scopes.** Rejected: it breaks access control based on scopes and the pull model of ADR-0003.
5. **Exact start and end times in a chosen time zone.** Rejected (user decision): trips that cross time zones get awkward at the edges, and capture times are local anyway.
6. **Auto-adding photos only, or photos and videos only.** Rejected (user decision): notes written during a trip belong to it as much as photos do.
7. **Keeping auto-added items as they are when a travel becomes shared.** Rejected (user decision): it would publish photos nobody approved.

## Consequences

- **Good:**
  - travels overlap freely, and albums are unchanged;
  - auto-add works offline and converges on every device;
  - nothing reaches other people without approval;
  - skipped items stay private;
  - travels reuse scopes, conflicts and public-link privacy as they are.
- **Bad:**
  - every edit to an item also rewrites its entry in each travel it's in;
  - there is a cap on albums and travels per item (ADR-0008);
  - each travel is one more scope for pulls to read;
  - entries duplicate item metadata;
  - the client needs a full-screen review, a preview of what a date change will do, and logic to re-apply the rule.
- **Follow-ups:**
  - data-model LLD: travel keys, entries and exclusions;
  - sync LLD: rewriting entry copies, and the re-apply triggers;
  - a UX design for the review queue.

## Parameters

- The cap on travels per item is defined in [ADR-0008](0008-items-in-many-albums.md), which counts albums and travels together.
- Review shows previews full screen (decision 5), so the preview size pinned in `docs/ear.md` must look good full screen on a phone or tablet.

## Validation spike

1. A transaction that updates an item and its entries in 20 travel scopes, with all the heads, stays within DynamoDB limits and runs at a reasonable speed.
2. Local capture times are available from iPhone and Android photo and video files, including ones picked in the browser, and from media captured in the browser.

## References

- [HLD](../hld.md) §2, §4, §6, §8, §9; [requirements](../requirements.md) REQ-009, REQ-034–REQ-044, REQ-059, REQ-065, REQ-066, REQ-068–REQ-078.
- [ADR-0003](0003-sync-scopes.md) (scopes), [ADR-0004](0004-conflict-versioning.md) (conflicts), [ADR-0006](0006-public-media-location.md) (public links).
